<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/src/Mp4Metadata.php';
require_once dirname(__DIR__) . '/src/Database.php';
require_once dirname(__DIR__) . '/src/Indexer.php';

use CtvPhp\Database;
use CtvPhp\Indexer;
use CtvPhp\Mp4Metadata;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function box(string $type, string $payload): string
{
    return pack('N', 8 + strlen($payload)) . $type . $payload;
}

$tmp = sys_get_temp_dir() . '/ctv_php_test_' . bin2hex(random_bytes(5));
mkdir($tmp, 0777, true);
try {
    $mvhdPayload = chr(0) . "\0\0\0" . pack('N', 0) . pack('N', 0) . pack('N', 1000) . pack('N', 28800) . str_repeat("\0", 80);
    $mp4 = box('ftyp', 'isom' . str_repeat("\0", 12)) . box('moov', box('mvhd', $mvhdPayload));
    $file = $tmp . '/Camera_00_20260930001821.mp4';
    file_put_contents($file, $mp4);
    check(abs(Mp4Metadata::duration($file) - 28.8) < 0.001, 'MP4 mvhd duration should be parsed');

    $zeroMvhd = chr(0) . "\0\0\0" . pack('N', 0) . pack('N', 0) . pack('N', 1000) . pack('N', 0) . str_repeat("\0", 80);
    $tkhd = chr(0) . "\0\0\0" . pack('N', 0) . pack('N', 0) . pack('N', 1) . pack('N', 0) . pack('N', 0) . str_repeat("\0", 64);
    $mdhd = chr(0) . "\0\0\0" . pack('N', 0) . pack('N', 0) . pack('N', 1000) . pack('N', 0) . pack('N', 0);
    $trex = chr(0) . "\0\0\0" . pack('N', 1) . pack('N', 1) . pack('N', 100) . pack('N', 0) . pack('N', 0);
    $fragmented = box('ftyp', 'isom' . str_repeat("\0", 12))
        . box('moov', box('mvhd', $zeroMvhd) . box('trak', box('tkhd', $tkhd) . box('mdia', box('mdhd', $mdhd))) . box('mvex', box('trex', $trex)))
        . box('moof', box('traf', box('tfhd', chr(0) . "\0\0\0" . pack('N', 1)) . box('trun', chr(0) . "\0\0\0" . pack('N', 10))))
        . box('mdat', str_repeat("\0", 16));
    $fragmentedFile = $tmp . '/fragmented.mp4';
    file_put_contents($fragmentedFile, $fragmented);
    check(abs(Mp4Metadata::duration($fragmentedFile) - 1.0) < 0.001, 'Fragmented MP4 duration should be summed from trun/trex');
    check(count(Mp4Metadata::durationPatches($fragmentedFile, 1.0)) === 3, 'Fragmented MP4 should patch mvhd/tkhd/mdhd duration fields');

    $malformed = $tmp . '/empty-header.mp4';
    file_put_contents($malformed, box('moov', box('mvhd', '')));
    check(Mp4Metadata::duration($malformed) === 0.0, 'An empty MP4 header should not abort the whole scan');
    file_put_contents($malformed, box('moov', box('mvhd', '') . box('mvex', '')));
    check(Mp4Metadata::durationPatches($malformed, 1.0) === [], 'An empty fragmented MP4 header should be ignored');

    if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException('pdo_sqlite is required for the PHP integration tests');
    }

    $db = new Database($tmp . '/test.sqlite');
    $indexer = new Indexer($db, [
        'source_roots' => [$tmp],
        'timezone' => 'Europe/Zurich',
        'file_settle_seconds' => 0,
        'snapshot_max_distance_seconds' => 90,
    ]);
    $ts = $indexer->extractTimestamp(basename($file), 'Europe/Zurich');
    $expected = (new DateTimeImmutable('2026-09-30 00:18:21', new DateTimeZone('Europe/Zurich')))->getTimestamp();
    check((int) $ts === $expected, 'Reolink filename timestamp should parse in camera timezone');
    check($indexer->extractTimestamp('Camera_20260231001821.mp4', 'Europe/Zurich') === null, 'Invalid filename dates must not normalize to another day');
    try {
        $indexer->partitionPath($tmp, '{YYYY}/{MM}/{DD}', '2026-02-31');
        throw new RuntimeException('Invalid partition date was accepted');
    } catch (InvalidArgumentException) {
    }

    mkdir($tmp . '/FishEye1/2026/09/30', 0777, true);
    copy($file, $tmp . '/FishEye1/2026/09/30/Lager FishEye 1_00_20260930001821.mp4');
    file_put_contents($tmp . '/FishEye1/2026/09/30/Lager FishEye 1_00_20260930001819.jpg', "\xFF\xD8\xFF\xD9");
    $pdo = $db->pdo();
    $pdo->prepare("INSERT INTO cameras(name,source_path,timezone,indexing_mode,directory_pattern) VALUES(?,?,?,?,?)")
        ->execute(['FishEye1', $tmp . '/FishEye1', 'Europe/Zurich', 'partitioned', '{YYYY}/{MM}/{DD}']);
    $camera = $pdo->query('SELECT * FROM cameras')->fetch();
    $result = $indexer->indexPartition($camera, '2026-09-30');
    check($result['new'] === 1, 'One MP4 should be indexed');
    $row = $pdo->query('SELECT * FROM recordings')->fetch();
    check(abs((float) $row['duration'] - 28.8) < 0.001, 'Indexed duration should be stored');
    check($row['thumbnail_path'] !== null, 'Nearby Reolink JPG should be associated as thumbnail');
    unlink($row['path']);
    check($indexer->indexPartition($camera, '2026-09-30')['missing'] === 1, 'A removed recording should be marked missing');
    check($indexer->indexPartition($camera, '2026-09-30')['missing'] === 0, 'An already missing recording must not be counted again');

    fwrite(STDOUT, "ctv_php tests passed\n");
} finally {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $item) {
        $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
    }
    @rmdir($tmp);
}

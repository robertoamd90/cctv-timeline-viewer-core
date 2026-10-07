#!/usr/bin/env php
<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/src/bootstrap.php';

use CtvPhp\Indexer;
use function CtvPhp\config;
use function CtvPhp\database;

$options = getopt('', ['discover', 'camera:', 'all', 'date:', 'days:', 'help']);
if (isset($options['help'])) {
    fwrite(STDOUT, <<<TXT
CCTV Timeline Viewer PHP indexer

Usage:
  php ctv_php/bin/index.php [--discover] [--camera=ID] [--all]
  php ctv_php/bin/index.php [--camera=ID] --date=YYYY-MM-DD [--days=N]
  php ctv_php/bin/index.php [--camera=ID] --days=N

With no --date/--days, index all existing date directories, including history.
--all explicitly selects that mode; it cannot be combined with --date/--days.
--days=N indexes N dates ending on --date, or today in each camera timezone.
Use --days=2 for incremental cron scans. Full-directory cameras always
reconcile their whole source.
TXT);
    exit(0);
}

if (isset($options['all']) && (isset($options['date']) || isset($options['days']))) {
    fwrite(STDERR, "Use --all or --date/--days, not both.\n");
    exit(1);
}
$all = !isset($options['date']) && !isset($options['days']);

$database = database();
$pdo = $database->pdo();
$indexer = new Indexer($database, config());

if (isset($options['discover'])) {
    $count = $indexer->discover();
    fwrite(STDOUT, "Discovered $count new camera(s).\n");
}

$params = [];
$sql = 'SELECT * FROM cameras';
if (isset($options['camera'])) {
    $sql .= ' WHERE id = ?';
    $params[] = (int) $options['camera'];
}
$sql .= ' ORDER BY name';
$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$cameras = $stmt->fetchAll();

if (!$cameras) {
    fwrite(STDOUT, "No cameras configured. Use --discover or add them in the web UI.\n");
    exit(0);
}

$days = max(1, (int) ($options['days'] ?? 1));
$failed = false;
foreach ($cameras as $camera) {
    try {
        if ($camera['indexing_mode'] === 'full') {
            $result = $indexer->indexFull($camera);
            fwrite(STDOUT, sprintf("%s: %s\n", $camera['name'], json_encode($result, JSON_UNESCAPED_SLASHES)));
            continue;
        }
        if ($all) {
            $dates = $indexer->partitionDays($camera);
        } else {
            $zone = new \DateTimeZone($camera['timezone']);
            $base = isset($options['date'])
                ? \DateTimeImmutable::createFromFormat('!Y-m-d', (string) $options['date'], $zone)
                : new \DateTimeImmutable('today', $zone);
            if ($base === false || (isset($options['date']) && $base->format('Y-m-d') !== $options['date'])) {
                throw new RuntimeException('Invalid --date value. Use YYYY-MM-DD.');
            }
            $dates = [];
            for ($offset = $days - 1; $offset >= 0; $offset--) {
                $dates[] = $base->modify("-$offset days")->format('Y-m-d');
            }
        }
        $total = 0;
        foreach ($dates as $date) {
            try {
                $result = $indexer->indexPartition($camera, $date);
                $total += $result['total'];
                fwrite(STDOUT, sprintf("%s %s: %s\n", $camera['name'], $date, json_encode($result, JSON_UNESCAPED_SLASHES)));
            } catch (Throwable $error) {
                $failed = true;
                fwrite(STDERR, sprintf("%s %s: %s\n", $camera['name'], $date, $error->getMessage()));
            }
        }
        if ($all && $total === 0) {
            fwrite(STDOUT, sprintf("%s: No MP4 files found under %s. Check the camera source and directory pattern; for YYYY/MM/DD archives, the source must be above the year directory.\n", $camera['name'], $camera['source_path']));
        }
    } catch (Throwable $error) {
        $failed = true;
        fwrite(STDERR, sprintf("%s: %s\n", $camera['name'], $error->getMessage()));
    }
}
exit($failed ? 1 : 0);

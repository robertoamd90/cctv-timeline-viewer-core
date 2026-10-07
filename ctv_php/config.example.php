<?php

declare(strict_types=1);

// Prefer the guided installer: php ctv_php/setup.php (from the repository root).
return [
    // Camera directories or parent directories containing camera folders. Keep this
    // outside the public document root if possible.
    'source_roots' => [
        '/home/USER/path/to/reolink-backup',
    ],

    // SQLite lives here. The default (ctv_php/var) is already outside
    // ctv_php/public and is suitable for shared hosting.
    'data_dir' => __DIR__ . '/var',

    // Reuse the upstream vanilla-JS frontend directly from the fork.
    'web_root' => dirname(__DIR__) . '/ctv_web',

    'timezone' => 'Europe/Zurich',

    // Required bcrypt htpasswd file, outside the public document root.
    // Created by setup.php, or: htpasswd -cB -C 10 ctv_php/.htpasswd alex
    'password_file' => __DIR__ . '/.htpasswd',

    // Ignore files that may still be uploading over FTP/FTPS.
    'file_settle_seconds' => 30,

    // Reolink snapshots are matched to nearby recordings for thumbnails.
    'snapshot_max_distance_seconds' => 90,

    // All authenticated users share this role. false allows viewing/indexing
    // requested days, but prevents camera changes, manual scans and rebuilds.
    'admin' => true,
];

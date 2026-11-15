<?php
declare(strict_types=1);

// Copy to config/local.php outside ALL website document roots; never commit it.
return [
    'origin' => 'https://fukidashi.nasunozaki-proclub.com',
    // Use the dedicated application database/user, NOT the WordPress database.
    'database' => [
        'dsn' => 'mysql:host=localhost;port=3306;dbname=ACCOUNT_fukidashi;charset=utf8mb4',
        'user' => 'ACCOUNT_fukidashi',
        'password' => 'REPLACE_WITH_A_NEW_DATABASE_PASSWORD',
    ],
    // Include the main HP root as well as any other public roots on the account.
    // public/ in this application is always included automatically.
    'public_roots' => ['/home/ACCOUNT/public_html'],
    'cookie_secure' => true,
    // Absolute non-public directory. Create with permissions 0700.
    'backup_dir' => '/home/ACCOUNT/apps/fukidashi/backups',
];

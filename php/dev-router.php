<?php
declare(strict_types=1);

// Only for the PHP built-in development server. Apache uses public/.htaccess.
if (PHP_SAPI !== 'cli-server') { http_response_code(404); exit; }
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$assets = ['/app.js', '/styles.css', '/qrcode.min.js'];
if (in_array($path, $assets, true)) return false;
if (preg_match('#\A/(?:config|php|backups|data|\.git)(?:/|$)#i', $path)) {
    http_response_code(403); exit;
}
require dirname(__DIR__) . '/public/api.php';

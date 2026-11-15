<?php
declare(strict_types=1);
namespace Fukidashi;

use PDO;
use RuntimeException;

function isInside(string $path, string $root): bool
{
    return $path === $root || str_starts_with($path, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
}

function requirePrivatePath(string $path, array $config): string
{
    $resolved = realpath($path);
    if ($resolved === false) throw new RuntimeException('Private path does not exist.');
    foreach ($config['public_roots'] as $root) {
        $public = realpath($root);
        if ($public === false) throw new RuntimeException('A configured public root does not exist.');
        if (isInside($resolved, $public)) throw new RuntimeException('Private files must be outside all public roots.');
    }
    return $resolved;
}

function loadConfig(): array
{
    if (PHP_VERSION_ID < 80400) throw new RuntimeException('PHP 8.4 or later is required.');
    $path = getenv('FUKIDASHI_CONFIG') ?: dirname(__DIR__) . '/config/local.php';
    if (!is_file($path)) throw new RuntimeException('Create the non-public config/local.php first.');
    $config = require $path;
    if (!is_array($config)) throw new RuntimeException('Invalid configuration.');
    $origin = $config['origin'] ?? '';
    $parts = is_string($origin) ? parse_url($origin) : false;
    if (!$parts || !isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass'])
        || isset($parts['query']) || isset($parts['fragment']) || !empty($parts['path'])
        || !in_array($parts['scheme'], ['https', 'http'], true)) {
        throw new RuntimeException('origin must be an absolute origin without a path.');
    }
    $secure = $config['cookie_secure'] ?? true;
    if (!is_bool($secure)) throw new RuntimeException('cookie_secure must be boolean.');
    if ($parts['scheme'] !== 'https' || !$secure) {
        if (!in_array($parts['host'], ['localhost', '127.0.0.1', '[::1]'], true) || $secure) {
            throw new RuntimeException('HTTPS and secure cookies are required outside local development.');
        }
    }
    if (!isset($config['public_roots']) || !is_array($config['public_roots']) || !$config['public_roots']) {
        throw new RuntimeException('List all website public roots in public_roots.');
    }
    $config['public_dir'] = realpath($config['public_dir'] ?? dirname(__DIR__) . '/public');
    if ($config['public_dir'] === false || !is_dir($config['public_dir'])) throw new RuntimeException('public_dir must exist.');
    $config['public_roots'][] = $config['public_dir'];
    if (!empty($_SERVER['DOCUMENT_ROOT'])) $config['public_roots'][] = $_SERVER['DOCUMENT_ROOT'];
    $config['public_roots'] = array_unique($config['public_roots']);
    requirePrivatePath($path, $config);
    requirePrivatePath(__DIR__, $config);
    $config['cookie_secure'] = $secure;
    $database = $config['database'] ?? [];
    if (!is_array($database) || !str_starts_with($database['dsn'] ?? '', 'mysql:')
        || !preg_match('/(?:^|;)charset=utf8mb4(?:;|$)/', substr($database['dsn'], 6))
        || !is_string($database['user'] ?? null) || !is_string($database['password'] ?? null)) {
        throw new RuntimeException('Configure a dedicated MariaDB database with charset=utf8mb4.');
    }
    return $config;
}

function connect(array $config): PDO
{
    return new PDO($config['database']['dsn'], $config['database']['user'], $config['database']['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
}

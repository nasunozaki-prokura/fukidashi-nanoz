<?php
declare(strict_types=1);

const DEFAULT_PUBLISH_SECONDS = 2592000;

$dataFile = getenv('DOJO_DATA_FILE') ?: dirname(__DIR__) . '/data/boards.json';
if (!is_dir(dirname($dataFile))) {
    mkdir(dirname($dataFile), 0770, true);
}
$file = fopen($dataFile, 'c+');
if ($file === false || !flock($file, LOCK_EX)) {
    errorResponse(500, 'data file unavailable');
}

$db = json_decode(stream_get_contents($file) ?: '{"boards":{}}', true);
if (!is_array($db)) $db = ['boards' => []];
if (!isset($db['boards']) || !is_array($db['boards'])) $db['boards'] = [];
migrate($db);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

if (preg_match('#/join/([^/]+)/?$#', $path, $match)) {
    $key = boardKeyForToken($db, $match[1]);
    if ($key === null || !isAvailable($db['boards'][$key])) {
        saveDb($file, $db);
        unavailablePage();
    }
    saveDb($file, $db);
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/index.html');
    exit;
}

$path = preg_replace('#^.*?/api#', '/api', $path, 1);
if (!is_string($path) || !str_starts_with($path, '/api')) {
    errorResponse(404, 'not found');
}

$body = $method === 'GET' ? [] : requestBody();
$headerOwnerKey = (string) ($_SERVER['HTTP_X_OWNER_KEY'] ?? '');

if ($method === 'POST' && $path === '/api/boards') {
    $board = newBoard($body);
    $db['boards'][$board['id']] = $board;
    saveDb($file, $db);
    response(201, ownerBoard($board, $board['ownerKey']));
}

if ($method === 'POST' && $path === '/api/publish') {
    $id = (string) ($body['boardId'] ?? '');
    if (!isset($db['boards'][$id])) errorResponse(404, 'board not found');
    $board =& $db['boards'][$id];
    if ((string) ($body['ownerKey'] ?? '') !== $board['ownerKey']) {
        errorResponse(403, 'owner only');
    }
    $board['publishEndsAt'] = normalizedDate($body['publishEndsAt'] ?? null)
        ?? $board['publishEndsAt']
        ?? gmdate('c', time() + DEFAULT_PUBLISH_SECONDS);
    $board['publicToken'] = token(24);
    $board['publishEndedAt'] = null;
    touch($board);
    updateExpiry($board);
    saveDb($file, $db);
    response(200, ownerBoard($board, $board['ownerKey']));
}

if (preg_match('#^/api/public/([^/]+)(?:/([^/]+))?$#', $path, $match)) {
    $key = boardKeyForToken($db, $match[1]);
    if ($key === null || !isAvailable($db['boards'][$key])) {
        saveDb($file, $db);
        errorResponse(404, 'not found');
    }
    $board =& $db['boards'][$key];
    $action = $match[2] ?? '';
    if ($method === 'GET' && $action === '') {
        saveDb($file, $db);
        response(200, publicBoard($board));
    }
    changeBubbles($method, $action, $board, $body, userFrom($body));
    saveDb($file, $db);
    response($method === 'POST' && $action === 'bubbles' ? 201 : 200, publicBoard($board));
}

if (preg_match('#^/api/boards/([^/]+)(?:/([^/]+))?$#', $path, $match)) {
    $id = $match[1];
    if (!isset($db['boards'][$id])) errorResponse(404, 'board not found');
    $board =& $db['boards'][$id];
    $action = $match[2] ?? '';

    if ($method === 'GET' && $action === '') {
        if ($headerOwnerKey !== $board['ownerKey']) errorResponse(404, 'not found');
        updateExpiry($board);
        saveDb($file, $db);
        response(200, ownerBoard($board, $headerOwnerKey));
    }

    $user = userFrom($body);
    $user['ownerKey'] = (string) ($body['ownerKey'] ?? '');
    if ($method === 'PATCH' && $action === 'event') {
        requireOwner($board, $user);
        if (array_key_exists('publishEndsAt', $body)) {
            $board['publishEndsAt'] = normalizedDate($body['publishEndsAt']);
        }
        if (($body['endPublishNow'] ?? false) === true) {
            $board['publishEndedAt'] = gmdate('c');
        }
        touch($board);
        updateExpiry($board);
        saveDb($file, $db);
        response(200, ownerBoard($board, $user['ownerKey']));
    }
    requireOwner($board, $user, 404);
    changeBubbles($method, $action, $board, $body, $user);
    saveDb($file, $db);
    response($method === 'POST' && $action === 'bubbles' ? 201 : 200, ownerBoard($board, $user['ownerKey']));
}

errorResponse(404, 'not found');

function changeBubbles(string $method, string $action, array &$board, array $body, array $user): void
{
    if ($method === 'POST' && $action === 'bubbles') {
        $bubble = newBubble($body, $user);
        if ($bubble['text'] === '') errorResponse(400, 'text required');
        $board['bubbles'][] = $bubble;
        touch($board);
        return;
    }

    $index = bubbleIndex($board, (string) ($body['bubbleId'] ?? ''));
    if ($index === null) errorResponse(404, 'bubble not found');
    $bubble =& $board['bubbles'][$index];

    if ($method === 'PATCH' && $action === 'bubbles') {
        if (!canEdit($board, $bubble, $user)) errorResponse(403, 'locked');
        if (isset($body['text']) && is_string($body['text'])) {
            $text = shortened(trim($body['text']), 180);
            if ($text !== '') $bubble['text'] = $text;
        }
        if (array_key_exists('x', $body)) $bubble['x'] = coordinate($body['x']);
        if (array_key_exists('y', $body)) $bubble['y'] = coordinate($body['y']);
        $bubble['updatedAt'] = gmdate('c');
        touch($board);
        return;
    }

    if ($method === 'POST' && $action === 'like') {
        $bubble['likes'] = is_array($bubble['likes'] ?? null) ? $bubble['likes'] : [];
        $likeIndex = array_search($user['userId'], $bubble['likes'], true);
        if ($likeIndex === false) {
            $bubble['likes'][] = $user['userId'];
        } else {
            array_splice($bubble['likes'], (int) $likeIndex, 1);
        }
        touch($board);
        return;
    }
    errorResponse(404, 'not found');
}

function migrate(array &$db): void
{
    foreach ($db['boards'] as &$board) {
        if (!isset($board['bubbles']) || !is_array($board['bubbles'])) {
            $board['bubbles'] = [];
            foreach (($board['pages'] ?? []) as $page) {
                if (is_array($page['bubbles'] ?? null)) {
                    $board['bubbles'] = array_merge($board['bubbles'], $page['bubbles']);
                }
            }
        }
        $board['publishEndsAt'] = $board['publishEndsAt'] ?? $board['endsAt'] ?? null;
        $board['publishEndedAt'] = $board['publishEndedAt'] ?? $board['endedAt'] ?? null;
        $board['publicToken'] = $board['publicToken'] ?? null;
        unset($board['pages'], $board['currentPageId'], $board['endsAt'], $board['endedAt']);
    }
    unset($board, $db['activeBoardId']);
}

function newBoard(array $body): array
{
    $now = gmdate('c');
    $title = trim((string) ($body['title'] ?? ''));
    return [
        'id' => substr(token(8), 0, 8),
        'ownerKey' => uuid(),
        'title' => $title === '' ? '今日のふきだし' : shortened($title, 60),
        'publicToken' => null,
        'publishEndsAt' => normalizedDate($body['publishEndsAt'] ?? null),
        'publishEndedAt' => null,
        'createdAt' => $now,
        'updatedAt' => $now,
        'bubbles' => [],
    ];
}

function newBubble(array $body, array $user): array
{
    $now = gmdate('c');
    $author = trim($user['name']);
    return [
        'id' => uuid(),
        'text' => shortened(trim((string) ($body['text'] ?? '')), 180),
        'author' => $author === '' ? '匿名' : shortened($author, 24),
        'authorId' => $user['userId'],
        'x' => coordinate($body['x'] ?? 20),
        'y' => coordinate($body['y'] ?? 20),
        'likes' => [],
        'createdAt' => $now,
        'updatedAt' => $now,
    ];
}

function ownerBoard(array &$board, string $ownerKey): array
{
    updateExpiry($board);
    $owner = hash_equals((string) $board['ownerKey'], $ownerKey);
    $result = [
        'id' => $board['id'],
        'title' => $board['title'],
        'isOwner' => $owner,
        'isPublished' => !empty($board['publicToken']) && empty($board['publishEndedAt']),
        'publishEndsAt' => $board['publishEndsAt'] ?? null,
        'publishEndedAt' => $board['publishEndedAt'] ?? null,
        'createdAt' => $board['createdAt'],
        'updatedAt' => $board['updatedAt'],
        'bubbles' => $board['bubbles'],
    ];
    if ($owner) {
        $result['ownerKey'] = $board['ownerKey'];
        $result['publicToken'] = $board['publicToken'];
    }
    return $result;
}

function publicBoard(array $board): array
{
    return [
        'id' => $board['id'],
        'title' => $board['title'],
        'isOwner' => false,
        'isPublished' => true,
        'publishEndsAt' => $board['publishEndsAt'] ?? null,
        'createdAt' => $board['createdAt'],
        'updatedAt' => $board['updatedAt'],
        'bubbles' => $board['bubbles'],
    ];
}

function userFrom(array $body): array
{
    return [
        'userId' => (string) ($body['userId'] ?? ''),
        'name' => (string) ($body['name'] ?? '匿名'),
        'ownerKey' => '',
    ];
}

function requireOwner(array $board, array $user, int $status = 403): void
{
    if (($user['ownerKey'] ?? '') !== $board['ownerKey']) errorResponse($status, 'owner only');
}

function canEdit(array $board, array $bubble, array $user): bool
{
    return ($user['ownerKey'] ?? '') === $board['ownerKey']
        || ($bubble['authorId'] ?? '') === ($user['userId'] ?? '');
}

function bubbleIndex(array $board, string $id): ?int
{
    foreach ($board['bubbles'] as $index => $bubble) {
        if (($bubble['id'] ?? '') === $id) return $index;
    }
    return null;
}

function boardKeyForToken(array $db, string $token): ?string
{
    foreach ($db['boards'] as $key => $board) {
        if (($board['publicToken'] ?? null) === $token) return (string) $key;
    }
    return null;
}

function isAvailable(array &$board): bool
{
    updateExpiry($board);
    return !empty($board['publicToken']) && empty($board['publishEndedAt']);
}

function updateExpiry(array &$board): bool
{
    if (!empty($board['publishEndedAt']) || empty($board['publishEndsAt'])) return false;
    $endsAt = strtotime((string) $board['publishEndsAt']);
    if ($endsAt === false || time() < $endsAt) return false;
    $board['publishEndedAt'] = gmdate('c');
    touch($board);
    return true;
}

function normalizedDate(mixed $value): ?string
{
    if ($value === null || $value === '') return null;
    $time = strtotime((string) $value);
    return $time === false ? null : gmdate('c', $time);
}

function touch(array &$board): void
{
    $board['updatedAt'] = gmdate('c');
}

function coordinate(mixed $value): float
{
    return max(0.0, min(100.0, is_numeric($value) ? (float) $value : 20.0));
}

function shortened(string $value, int $length): string
{
    return function_exists('mb_substr') ? mb_substr($value, 0, $length) : substr($value, 0, $length);
}

function token(int $bytes): string
{
    return bin2hex(random_bytes($bytes));
}

function uuid(): string
{
    $hex = token(16);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-4' . substr($hex, 13, 3)
        . '-a' . substr($hex, 17, 3) . '-' . substr($hex, 20, 12);
}

function requestBody(): array
{
    $body = json_decode(file_get_contents('php://input') ?: '{}', true);
    return is_array($body) ? $body : [];
}

function saveDb($file, array $db): void
{
    rewind($file);
    ftruncate($file, 0);
    fwrite($file, json_encode($db, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($file);
    flock($file, LOCK_UN);
    fclose($file);
}

function response(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function errorResponse(int $status, string $message): never
{
    response($status, ['error' => $message]);
}

function unavailablePage(): never
{
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>現在このページは公開されていません</title>'
        . '<style>body{align-items:center;background:#eef3f6;color:#202124;display:flex;'
        . 'font-family:system-ui,sans-serif;justify-content:center;margin:0;min-height:100vh;'
        . 'padding:24px;text-align:center}main{background:#fff;border:1px solid #d9e0e7;'
        . 'border-radius:8px;max-width:560px;padding:36px 28px;width:100%}'
        . 'h1{font-size:22px;margin:0 0 12px}p{color:#64707d;margin:0}</style></head>'
        . '<body><main><h1>現在このページは公開されていません</h1>'
        . '<p>This page is currently unavailable.</p></main></body></html>';
    exit;
}

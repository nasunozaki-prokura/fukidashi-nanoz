<?php
declare(strict_types=1);
namespace Fukidashi;

use RuntimeException;
use Throwable;

const MAX_BODY_BYTES = 16384;
const MAX_BUBBLES = 1000;

final class HttpError extends RuntimeException
{
    public function __construct(public readonly int $status, string $message) { parent::__construct($message); }
}

final class Response
{
    public function __construct(public readonly string $body, public readonly int $status = 200, public readonly string $type = 'application/json; charset=utf-8') {}
}

function encode(mixed $value): string { return json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR); }
function timestamp(): string { return gmdate('Y-m-d\TH:i:s\Z'); }
function randomToken(): string { return bin2hex(random_bytes(32)); }
function shortened(string $value, int $length): string { return mb_substr($value, 0, $length, 'UTF-8'); }
function coordinate(mixed $value): float { return is_numeric($value) ? max(0.0, min(100.0, (float) $value)) : 20.0; }
function normalizedDate(mixed $value): ?string
{
    if ($value === null || $value === '') return null;
    if (!is_string($value) || ($time = strtotime($value)) === false) throw new HttpError(400, 'invalid date');
    return gmdate('Y-m-d\TH:i:s\Z', $time);
}
function textField(array $body, string $name, string $default = ''): string
{
    if (!array_key_exists($name, $body)) return $default;
    if (!is_string($body[$name])) throw new HttpError(400, 'invalid ' . $name);
    return $body[$name];
}
function isAvailable(array $board): bool
{
    return !empty($board['publicToken']) && empty($board['publishEndedAt'])
        && (empty($board['publishEndsAt']) || strtotime($board['publishEndsAt']) > time());
}
function boardView(array $board, string $ownerKey = ''): array
{
    $owner = $ownerKey !== '' && hash_equals($board['ownerKey'], $ownerKey);
    $view = [
        'id' => $board['id'], 'title' => $board['title'], 'isOwner' => $owner,
        'isPublished' => isAvailable($board), 'publishEndsAt' => $board['publishEndsAt'],
        'publishEndedAt' => $board['publishEndedAt'], 'createdAt' => $board['createdAt'],
        'updatedAt' => $board['updatedAt'], 'bubbles' => $board['bubbles'],
    ];
    if ($owner) $view += ['ownerKey' => $board['ownerKey'], 'publicToken' => $board['publicToken']];
    return $view;
}
function requireOwner(array $board, string $key): void
{
    if ($key === '' || !hash_equals($board['ownerKey'], $key)) throw new HttpError(404, 'not found');
}
function requireAvailable(array $board): void
{
    if (!isAvailable($board)) throw new HttpError(404, 'not found');
}
function jsonResponse(mixed $value, int $status = 200): Response { return new Response(encode($value), $status); }

function sessionCookieName(array $config): string
{
    return $config['cookie_secure'] ? '__Host-fukidashi_session' : 'fukidashi_session_dev';
}
function sessionToken(array $config): string
{
    $value = $_COOKIE[sessionCookieName($config)] ?? '';
    return is_string($value) && preg_match('/\A[a-f0-9]{64}\z/D', $value) ? $value : '';
}
function sessionResponse(array $config): Response
{
    $token = sessionToken($config) ?: randomToken();
    setcookie(sessionCookieName($config), $token, [
        'expires' => time() + 31536000, 'path' => '/', 'secure' => $config['cookie_secure'],
        'httponly' => true, 'samesite' => 'Lax',
    ]);
    return jsonResponse(['userId' => hash('sha256', $token)]);
}
function authenticatedUserId(array $config): string
{
    $token = sessionToken($config);
    if ($token === '') throw new HttpError(401, 'ページを再読み込みしてください');
    return hash('sha256', $token);
}
function requestBody(): array
{
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'request too large');
    if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new HttpError(415, 'JSON required');
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) throw new HttpError(413, 'request too large');
    try { $body = json_decode($raw, false, 32, JSON_THROW_ON_ERROR); }
    catch (Throwable) { throw new HttpError(400, 'invalid JSON'); }
    if (!$body instanceof \stdClass) throw new HttpError(400, 'JSON object required');
    return (array) $body;
}
function htmlResponse(array $config): Response
{
    $html = file_get_contents($config['public_dir'] . '/index.html');
    if ($html === false) throw new RuntimeException('Missing page.');
    return new Response(str_replace('<head>', '<head><meta name="server-session" content="true">', $html), 200, 'text/html; charset=utf-8');
}
function unavailableResponse(): Response
{
    return new Response('<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>現在このページは公開されていません</title></head><body><main><h1>現在このページは公開されていません</h1><p>This page is currently unavailable.</p></main></body></html>', 404, 'text/html; charset=utf-8');
}

function handleRequest(array $config, callable $getStore): Response
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $authority = parse_url($config['origin'], PHP_URL_HOST);
    $port = parse_url($config['origin'], PHP_URL_PORT);
    if ($port !== null) $authority .= ':' . $port;
    if (strcasecmp($_SERVER['HTTP_HOST'] ?? '', $authority) !== 0) throw new HttpError(400, 'invalid host');
    if ($method === 'OPTIONS') throw new HttpError(405, 'method not allowed');
    if ($method === 'GET' && $path === '/api/session') return sessionResponse($config);
    if ($method === 'GET' && ($path === '/' || $path === '/admin')) return htmlResponse($config);
    if ($method === 'GET' && preg_match('#\A/join/([a-zA-Z0-9-]+)\z#D', $path, $join)) {
        $board = $getStore()->find($join[1], true);
        return $board && isAvailable($board) ? htmlResponse($config) : unavailableResponse();
    }
    if (!str_starts_with($path, '/api/')) throw new HttpError(404, 'not found');
    $body = [];
    $userId = '';
    if ($method !== 'GET') {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '' && $origin !== $config['origin']) throw new HttpError(403, 'invalid origin');
        if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new HttpError(403, 'invalid origin');
        $body = requestBody();
        $userId = authenticatedUserId($config);
    }
    $ownerKey = $method === 'GET' ? ($_SERVER['HTTP_X_OWNER_KEY'] ?? '') : textField($body, 'ownerKey');
    $store = $getStore();
    if ($method === 'POST' && $path === '/api/boards') {
        $board = [
            'id' => bin2hex(random_bytes(16)), 'ownerKey' => randomToken(),
            'title' => shortened(trim(textField($body, 'title')), 60) ?: '今日のふきだし',
            'publicToken' => null, 'publishEndsAt' => normalizedDate($body['publishEndsAt'] ?? null),
            'publishEndedAt' => null, 'createdAt' => timestamp(), 'updatedAt' => timestamp(), 'bubbles' => [],
        ];
        $store->insert($board);
        return jsonResponse(boardView($board, $board['ownerKey']), 201);
    }
    if ($method === 'POST' && $path === '/api/publish') {
        $board = $store->change(textField($body, 'boardId'), false, static function (array &$board) use ($body, $ownerKey): void {
            requireOwner($board, $ownerKey);
            $board['publishEndsAt'] = normalizedDate($body['publishEndsAt'] ?? null) ?? $board['publishEndsAt'] ?? gmdate('Y-m-d\TH:i:s\Z', time() + 2592000);
            $board['publicToken'] = randomToken();
            $board['publishEndedAt'] = null;
        });
        return jsonResponse(boardView($board, $ownerKey));
    }
    if (!preg_match('#\A/api/(boards|public)/([a-zA-Z0-9-]+)(?:/(bubbles|like|event))?\z#D', $path, $match)) throw new HttpError(404, 'not found');
    $public = $match[1] === 'public';
    $action = $match[3] ?? '';
    $authorize = static function (array $board) use ($public, $ownerKey): void {
        if ($public) requireAvailable($board); else requireOwner($board, $ownerKey);
    };
    if ($method === 'GET' && $action === '') {
        $board = $store->find($match[2], $public);
        if ($board === null) throw new HttpError(404, 'not found');
        $authorize($board);
        return jsonResponse(boardView($board, $public ? '' : $ownerKey));
    }
    $allowed = ($method === 'POST' && in_array($action, ['bubbles', 'like'], true))
        || ($method === 'PATCH' && ($action === 'bubbles' || ($action === 'event' && !$public)));
    if (!$allowed) throw new HttpError(405, 'method not allowed');
    $board = $store->change($match[2], $public, static function (array &$board) use ($authorize, $body, $method, $action, $public, $userId): void {
        $authorize($board);
        if ($action === 'event') {
            if (array_key_exists('publishEndsAt', $body)) $board['publishEndsAt'] = normalizedDate($body['publishEndsAt']);
            if (($body['endPublishNow'] ?? false) === true) $board['publishEndedAt'] = timestamp();
            return;
        }
        if ($method === 'POST' && $action === 'bubbles') {
            $text = shortened(trim(textField($body, 'text')), 180);
            if ($text === '') throw new HttpError(400, 'text required');
            if (count($board['bubbles']) >= MAX_BUBBLES) throw new HttpError(400, 'このボードは投稿上限に達しました');
            $board['bubbles'][] = [
                'id' => bin2hex(random_bytes(16)), 'text' => $text,
                'author' => shortened(trim(textField($body, 'name', '匿名')), 24) ?: '匿名', 'authorId' => $userId,
                'x' => coordinate($body['x'] ?? 20), 'y' => coordinate($body['y'] ?? 20), 'likes' => [],
                'createdAt' => timestamp(), 'updatedAt' => timestamp(),
            ];
            return;
        }
        $id = textField($body, 'bubbleId');
        foreach ($board['bubbles'] as &$bubble) {
            if ($bubble['id'] !== $id) continue;
            if ($action === 'bubbles') {
                if ($public && $bubble['authorId'] !== $userId) throw new HttpError(403, 'locked');
                if (array_key_exists('text', $body)) $bubble['text'] = shortened(trim(textField($body, 'text')), 180) ?: $bubble['text'];
                if (array_key_exists('x', $body)) $bubble['x'] = coordinate($body['x']);
                if (array_key_exists('y', $body)) $bubble['y'] = coordinate($body['y']);
                $bubble['updatedAt'] = timestamp();
            } else {
                $index = array_search($userId, $bubble['likes'], true);
                if ($index === false) $bubble['likes'][] = $userId; else array_splice($bubble['likes'], $index, 1);
            }
            return;
        }
        throw new HttpError(404, 'bubble not found');
    });
    return jsonResponse(boardView($board, $public ? '' : $ownerKey), $method === 'POST' && $action === 'bubbles' ? 201 : 200);
}

function runHttp(): void
{
    ini_set('display_errors', '0');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    try {
        $config = loadConfig();
        if (!extension_loaded('mbstring')) throw new RuntimeException('mbstring is required.');
        $store = null;
        $getStore = static function () use (&$store, $config): Store { return $store ??= new Store(connect($config)); };
        $response = handleRequest($config, $getStore);
    } catch (HttpError $error) {
        $response = jsonResponse(['error' => $error->getMessage()], $error->status);
    } catch (Throwable $error) {
        error_log('Fukidashi: ' . $error->getMessage());
        $response = jsonResponse(['error' => 'サーバーの設定または接続を確認してください'], 503);
    }
    http_response_code($response->status);
    header('Content-Type: ' . $response->type);
    echo $response->body;
}

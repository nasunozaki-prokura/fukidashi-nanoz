<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/bootstrap.php';

use Fukidashi\Store;
use function Fukidashi\connect;
use function Fukidashi\encode;
use function Fukidashi\loadConfig;
use function Fukidashi\normalizedDate;
use function Fukidashi\requirePrivatePath;

function importBoards(array $input): array
{
    if (isset($input['format']) && $input['format'] !== 'fukidashi-boards-v1') throw new RuntimeException('Unknown backup format.');
    // Supports our snapshots, Node.js boards.json and raw D1 rows (data column).
    $boards = $input['boards'] ?? $input;
    if (!is_array($boards)) throw new RuntimeException('Invalid boards.');
    $result = [];
    foreach ($boards as $board) {
        if (is_array($board) && isset($board['data']) && is_string($board['data'])) $board = json_decode($board['data'], true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($board)) throw new RuntimeException('Invalid board.');
        if (!preg_match('/\A[a-zA-Z0-9-]{8,36}\z/D', $board['id'] ?? '')
            || !preg_match('/\A[a-fA-F0-9-]{32,128}\z/D', $board['ownerKey'] ?? '')) throw new RuntimeException('Invalid board identity.');
        $board['publicToken'] ??= null;
        if ($board['publicToken'] !== null && !preg_match('/\A[a-zA-Z0-9-]{16,64}\z/D', $board['publicToken'])) throw new RuntimeException('Invalid public token.');
        if (!isset($board['bubbles']) && isset($board['pages']) && is_array($board['pages'])) {
            $board['bubbles'] = [];
            foreach ($board['pages'] as $page) $board['bubbles'] = array_merge($board['bubbles'], $page['bubbles'] ?? []);
        }
        $board['bubbles'] ??= [];
        if (!is_array($board['bubbles']) || !array_is_list($board['bubbles']) || count($board['bubbles']) > Fukidashi\MAX_BUBBLES) throw new RuntimeException('Invalid bubbles or post limit exceeded.');
        foreach ($board['bubbles'] as $bubble) {
            foreach (['id', 'text', 'author', 'authorId', 'createdAt', 'updatedAt'] as $field) {
                if (!is_string($bubble[$field] ?? null)) throw new RuntimeException('Invalid bubble field.');
            }
            if (!isset($bubble['x'], $bubble['y'], $bubble['likes']) || !is_numeric($bubble['x']) || !is_numeric($bubble['y'])
                || !is_array($bubble['likes']) || !array_is_list($bubble['likes'])) throw new RuntimeException('Invalid bubble data.');
            foreach ($bubble['likes'] as $user) if (!is_string($user)) throw new RuntimeException('Invalid likes.');
        }
        if (!is_string($board['title'] ?? null) || !is_string($board['createdAt'] ?? null) || !is_string($board['updatedAt'] ?? null)) throw new RuntimeException('Invalid board fields.');
        $board['publishEndsAt'] = normalizedDate($board['publishEndsAt'] ?? $board['endsAt'] ?? null);
        $board['publishEndedAt'] = normalizedDate($board['publishEndedAt'] ?? $board['endedAt'] ?? null);
        unset($board['pages'], $board['currentPageId'], $board['endsAt'], $board['endedAt']);
        $result[] = $board;
    }
    return $result;
}

try {
    $command = $argv[1] ?? 'help';
    if ($command === 'help') {
        echo "Usage: php php/bin/manage.php check|setup|backup|restore /private/backup.json\n";
        exit(0);
    }
    if (!in_array($command, ['check', 'setup', 'backup', 'restore'], true) || count($argv) !== ($command === 'restore' ? 3 : 2)) throw new RuntimeException('Invalid arguments. Use help.');
    if (PHP_VERSION_ID < 80400 || !extension_loaded('pdo_mysql') || !extension_loaded('mbstring')) throw new RuntimeException('PHP 8.4+, pdo_mysql and mbstring are required.');
    umask(0077);
    $config = loadConfig();
    $pdo = connect($config);
    $store = new Store($pdo);
    if ($command === 'setup') {
        $count = (int) $pdo->query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()')->fetchColumn();
        if ($count !== 0) throw new RuntimeException('Setup requires an EMPTY dedicated database. No tables were changed.');
        $pdo->exec(file_get_contents(dirname(__DIR__) . '/schema.mysql.sql'));
        echo "Created boards table in the empty application database.\n";
    } elseif ($command === 'check') {
        $engine = $pdo->query("SELECT ENGINE FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'boards'")->fetchColumn();
        if ($engine !== 'InnoDB') throw new RuntimeException('An InnoDB boards table is required. Run setup for an empty application DB.');
        $pdo->query('SELECT id, public_token, data, version FROM boards LIMIT 0');
        requirePrivatePath($config['backup_dir'], $config);
        if (!is_writable($config['backup_dir'])) throw new RuntimeException('Backup directory is not writable.');
        echo 'OK: PHP ' . PHP_VERSION . ', PDO MySQL, mbstring, InnoDB, private config and backup directory.' . PHP_EOL;
    } elseif ($command === 'backup') {
        $dir = requirePrivatePath($config['backup_dir'], $config);
        if (!is_dir($dir) || !is_writable($dir)) throw new RuntimeException('Backup directory is not writable.');
        $target = $dir . '/boards-' . gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(4)) . '.json';
        $temp = tempnam($dir, '.snapshot-');
        if ($temp === false) throw new RuntimeException('Cannot create backup.');
        try {
            $data = encode($store->snapshot()) . "\n";
            if (file_put_contents($temp, $data) !== strlen($data) || !chmod($temp, 0600) || !rename($temp, $target)) throw new RuntimeException('Backup write failed.');
        } finally { if (is_file($temp)) unlink($temp); }
        echo $target . PHP_EOL;
    } else {
        $source = requirePrivatePath($argv[2], $config);
        if (!is_file($source) || filesize($source) > 64 * 1024 * 1024) throw new RuntimeException('Backup must be a file of at most 64 MiB.');
        $boards = importBoards(json_decode(file_get_contents($source), true, 512, JSON_THROW_ON_ERROR));
        $pdo->beginTransaction();
        try {
            if ($pdo->query('SELECT id FROM boards LIMIT 1 FOR UPDATE')->fetch()) throw new RuntimeException('Restore requires an EMPTY application table. Existing boards were not changed.');
            foreach ($boards as $board) $store->insert($board);
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
        echo 'Restored ' . count($boards) . " boards. Owner keys and public tokens were preserved.\n";
    }
} catch (Throwable $error) {
    // CLI only; no credentials are printed by this tool.
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}

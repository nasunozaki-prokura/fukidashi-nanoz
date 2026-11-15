<?php
declare(strict_types=1);
namespace Fukidashi;

use PDO;
use Throwable;

final class Store
{
    public function __construct(public readonly PDO $pdo) {}

    public function find(string $value, bool $public = false, bool $lock = false): ?array
    {
        $column = $public ? 'public_token' : 'id';
        $statement = $this->pdo->prepare('SELECT data FROM boards WHERE ' . $column . ' = ?' . ($lock ? ' FOR UPDATE' : ''));
        $statement->execute([$value]);
        $row = $statement->fetch();
        return $row ? json_decode($row['data'], true, 512, JSON_THROW_ON_ERROR) : null;
    }

    public function insert(array $board): void
    {
        $statement = $this->pdo->prepare('INSERT INTO boards (id, public_token, data) VALUES (?, ?, ?)');
        $statement->execute([$board['id'], $board['publicToken'], encode($board)]);
    }

    public function change(string $value, bool $public, callable $mutate): array
    {
        $this->pdo->beginTransaction();
        try {
            $board = $this->find($value, $public, true);
            if ($board === null) throw new HttpError(404, 'not found');
            $mutate($board);
            $board['updatedAt'] = timestamp();
            $statement = $this->pdo->prepare('UPDATE boards SET public_token = ?, data = ?, version = version + 1 WHERE id = ?');
            $statement->execute([$board['publicToken'], encode($board), $board['id']]);
            $this->pdo->commit();
            return $board;
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) $this->pdo->rollBack();
            throw $error;
        }
    }

    public function snapshot(): array
    {
        // One InnoDB SELECT sees a consistent snapshot; do not log its contents.
        $rows = $this->pdo->query('SELECT data FROM boards ORDER BY id')->fetchAll();
        return ['format' => 'fukidashi-boards-v1', 'exportedAt' => timestamp(), 'boards' => array_map(
            static fn(array $row): array => json_decode($row['data'], true, 512, JSON_THROW_ON_ERROR), $rows
        )];
    }
}

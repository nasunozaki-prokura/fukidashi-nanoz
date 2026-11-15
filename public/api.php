<?php
declare(strict_types=1);

$appRoot = getenv('FUKIDASHI_APP_ROOT') ?: dirname(__DIR__);
require $appRoot . '/php/bootstrap.php';
\Fukidashi\runHttp();

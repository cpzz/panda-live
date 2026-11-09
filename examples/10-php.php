<?php
// 示例：枚举、构造器属性与数组函数。
declare(strict_types=1);

enum Status: string
{
    case Active = 'active';
    case Archived = 'archived';
}

final class Task
{
    public function __construct(
        public readonly string $title,
        public Status $status = Status::Active,
    ) {
    }

    public function isActive(): bool
    {
        return $this->status === Status::Active;
    }
}

$tasks = [
    new Task('写文档'),
    new Task('归档旧任务', Status::Archived),
];

$active = array_filter($tasks, fn (Task $task): bool => $task->isActive());

echo count($active), " 个进行中的任务\n";

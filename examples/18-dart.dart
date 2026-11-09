// 示例：类、异步与集合。
class Task {
  Task({required this.title, this.done = false});

  final String title;
  bool done;

  String get label => done ? '已完成：$title' : '待办：$title';
}

Future<int> countPending(List<Task> tasks) async {
  await Future<void>.delayed(const Duration(milliseconds: 10));
  return tasks.where((task) => !task.done).length;
}

Future<void> main() async {
  final tasks = [Task(title: '写文档'), Task(title: '发布版本', done: true)];

  for (final task in tasks) {
    print(task.label);
  }
  print('待办数量：${await countPending(tasks)}');
}

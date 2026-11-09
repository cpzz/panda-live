// 示例：记录、模式匹配与 LINQ。
using System;
using System.Collections.Generic;
using System.Linq;

namespace Demo;

public record Student(string Name, int Score);

public static class Program
{
    public static string Grade(int score) => score switch
    {
        >= 90 => "A",
        >= 80 => "B",
        >= 60 => "C",
        _ => "D",
    };

    public static void Main()
    {
        var students = new List<Student>
        {
            new("Alice", 95),
            new("Bob", 72),
        };

        foreach (var student in students.OrderByDescending(item => item.Score))
        {
            Console.WriteLine($"{student.Name}: {Grade(student.Score)}");
        }
    }
}

"""示例：数据类、类型标注与生成器。"""

from dataclasses import dataclass
from typing import Iterator


@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def length(self) -> float:
        return (self.x**2 + self.y**2) ** 0.5


def fibonacci(count: int) -> Iterator[int]:
    previous, current = 0, 1
    for _ in range(count):
        yield previous
        previous, current = current, previous + current


def main() -> None:
    values = list(fibonacci(10))
    print(f"前 10 项：{values}")
    print(f"长度：{Point(3, 4).length():.2f}")


if __name__ == "__main__":
    main()

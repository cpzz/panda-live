// 示例：记录类型、流与异常处理。
import java.util.List;
import java.util.stream.Collectors;

public class Demo {
    public record Point(int x, int y) {
        public int manhattan() {
            return Math.abs(x) + Math.abs(y);
        }
    }

    public static void main(String[] args) {
        List<Point> points = List.of(new Point(1, 2), new Point(-3, 4));

        List<Integer> distances = points.stream()
                .map(Point::manhattan)
                .sorted()
                .collect(Collectors.toList());
        System.out.println(distances);

        try {
            int value = Integer.parseInt("42");
            System.out.println("解析结果：" + value);
        } catch (NumberFormatException error) {
            System.err.println("解析失败：" + error.getMessage());
        }
    }
}

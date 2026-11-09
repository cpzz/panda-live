// 示例：接口、泛型与联合类型。
interface Shape {
  readonly kind: "circle" | "square";
  size: number;
}

function area(shape: Shape): number {
  return shape.kind === "circle"
    ? Math.PI * shape.size ** 2
    : shape.size * shape.size;
}

function total<T extends Shape>(shapes: readonly T[]): number {
  return shapes.reduce((sum, shape) => sum + area(shape), 0);
}

const shapes: Shape[] = [
  { kind: "circle", size: 2 },
  { kind: "square", size: 3 },
];

console.log(total(shapes).toFixed(2));

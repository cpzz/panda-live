// 示例：协议、结构体与错误处理。
import Foundation

protocol Shape {
    var area: Double { get }
}

struct Circle: Shape {
    let radius: Double

    var area: Double {
        .pi * radius * radius
    }
}

enum ShapeError: Error {
    case invalidSize
}

func describe(_ shapes: [Shape]) throws -> String {
    guard !shapes.isEmpty else {
        throw ShapeError.invalidSize
    }
    let total = shapes.reduce(0) { $0 + $1.area }
    return String(format: "总面积：%.2f", total)
}

do {
    print(try describe([Circle(radius: 1), Circle(radius: 2)]))
} catch {
    print("计算失败：\(error)")
}

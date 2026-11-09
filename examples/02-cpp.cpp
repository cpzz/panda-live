// 示例：模板、智能指针与范围循环。
#include <iostream>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

namespace demo {

template <typename T>
T sum(const std::vector<T>& values) {
    return std::accumulate(values.begin(), values.end(), T{});
}

class Greeter {
public:
    explicit Greeter(std::string name) : name_(std::move(name)) {}

    void hello() const { std::cout << "Hello, " << name_ << '\n'; }

private:
    std::string name_;
};

}  // namespace demo

int main() {
    auto numbers = std::make_unique<std::vector<int>>(std::vector<int>{1, 2, 3, 4});
    std::cout << "sum = " << demo::sum(*numbers) << '\n';

    demo::Greeter{"Panda"}.hello();
    return 0;
}

// 示例：数据类、扩展函数与空安全。
data class User(val name: String, val age: Int?)

fun User.introduce(): String {
    val ageText = age?.let { "$it 岁" } ?: "年龄未知"
    return "$name，$ageText"
}

fun main() {
    val users = listOf(User("Alice", 30), User("Bob", null))
    val adults = users.filter { (it.age ?: 0) >= 18 }

    adults.forEach { println(it.introduce()) }
    println("成年用户：${adults.size}")
}

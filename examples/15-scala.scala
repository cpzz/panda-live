// 示例：样例类、模式匹配与集合。
case class Order(id: Int, amount: Double, paid: Boolean)

object Demo {
  def label(order: Order): String = order match {
    case Order(_, amount, true) if amount > 100 => "大额已支付"
    case Order(_, _, true) => "已支付"
    case _ => "待支付"
  }

  def main(args: Array[String]): Unit = {
    val orders = List(Order(1, 120.0, paid = true), Order(2, 80.0, paid = false))
    val pending = orders.collect { case order if !order.paid => order.id }

    orders.foreach(order => println(s"#${order.id} ${label(order)}"))
    println(s"待支付订单：$pending")
  }
}

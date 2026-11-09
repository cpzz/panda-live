# 示例：模块、块与符号。
module Describable
  def describe
    "#{self.class.name}(#{name})"
  end
end

class Item
  include Describable
  attr_reader :name, :price

  def initialize(name, price)
    @name = name
    @price = price
  end

  def discounted(rate)
    price * (1 - rate)
  end
end

items = [Item.new("笔", 10), Item.new("本子", 25)]
total = items.sum { |item| item.discounted(0.1) }

items.each { |item| puts item.describe }
puts format("合计：%.2f", total)

-- 示例：表、元方法与迭代。
local Account = {}
Account.__index = Account

function Account.new(owner, balance)
  return setmetatable({ owner = owner, balance = balance or 0 }, Account)
end

function Account:deposit(amount)
  self.balance = self.balance + amount
  return self
end

function Account:__tostring()
  return string.format("%s: %.2f", self.owner, self.balance)
end

local accounts = {
  Account.new("Alice", 10),
  Account.new("Bob"):deposit(25),
}

for index, account in ipairs(accounts) do
  print(index, tostring(account))
end

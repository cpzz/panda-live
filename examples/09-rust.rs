// 示例：所有权、trait 与错误处理。
use std::fmt;

#[derive(Debug, Clone)]
struct Account {
    owner: String,
    balance: i64,
}

impl fmt::Display for Account {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} 分", self.owner, self.balance)
    }
}

fn deposit(account: &mut Account, amount: i64) -> Result<i64, String> {
    if amount <= 0 {
        return Err(format!("金额必须为正数：{amount}"));
    }
    account.balance += amount;
    Ok(account.balance)
}

fn main() {
    let mut account = Account {
        owner: String::from("Panda"),
        balance: 0,
    };

    match deposit(&mut account, 500) {
        Ok(balance) => println!("{account}（余额 {balance}）"),
        Err(error) => eprintln!("{error}"),
    }
}

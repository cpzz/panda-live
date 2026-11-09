# 示例：向量、数据框与 apply 系列。
scores <- data.frame(
  name = c("Alice", "Bob", "Cara"),
  score = c(95, 72, 88),
  stringsAsFactors = FALSE
)

grade <- function(score) {
  if (score >= 90) {
    "A"
  } else if (score >= 80) {
    "B"
  } else {
    "C"
  }
}

scores$grade <- vapply(scores$score, grade, character(1))
print(scores[order(-scores$score), ])
cat("平均分：", mean(scores$score), "\n")

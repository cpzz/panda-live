-- 示例：CTE、连接与窗口函数。
WITH monthly AS (
    SELECT customer_id, SUM(amount) AS total
    FROM orders
    WHERE created_at >= DATE '2025-01-01'
    GROUP BY customer_id
)
SELECT c.name,
       m.total,
       RANK() OVER (ORDER BY m.total DESC) AS ranking
FROM monthly AS m
JOIN customers AS c ON c.id = m.customer_id
WHERE m.total > 100
ORDER BY ranking
LIMIT 10;

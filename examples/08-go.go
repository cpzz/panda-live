// 示例：结构体、错误处理与 goroutine。
package main

import (
	"errors"
	"fmt"
	"sync"
)

var ErrEmpty = errors.New("empty list")

func average(values []float64) (float64, error) {
	if len(values) == 0 {
		return 0, ErrEmpty
	}
	sum := 0.0
	for _, value := range values {
		sum += value
	}
	return sum / float64(len(values)), nil
}

func main() {
	var wg sync.WaitGroup

	for _, values := range [][]float64{{1, 2}, {3, 4}} {
		wg.Add(1)
		go func(v []float64) {
			defer wg.Done()
			if result, err := average(v); err == nil {
				fmt.Printf("平均：%.2f\n", result)
			}
		}(values)
	}

	wg.Wait()
}

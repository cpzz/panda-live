/* 示例：结构体、函数指针与宏。 */
#include <stdio.h>
#include <stdlib.h>

#define MAX_ITEMS 8

typedef struct {
    const char *name;
    int score;
} Item;

static int compare(const void *lhs, const void *rhs) {
    const Item *a = lhs;
    const Item *b = rhs;
    return b->score - a->score;
}

int main(void) {
    Item items[MAX_ITEMS] = {
        {"alpha", 12},
        {"beta", 30},
        {"gamma", 7},
    };

  
    qsort(items, 3, sizeof(Item), compare);

    for (int i = 0; i < 3; i++) {
        printf("%-6s %d\n", items[i].name, items[i].score);
    }
    return 0;
}

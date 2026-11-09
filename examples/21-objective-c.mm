// 示例：类接口、快速枚举与块语法。
#import <Foundation/Foundation.h>

@interface Greeter : NSObject

@property (nonatomic, copy) NSString *name;

- (instancetype)initWithName:(NSString *)name;
- (void)greet;

@end

@implementation Greeter

- (instancetype)initWithName:(NSString *)name {
    self = [super init];
    if (self) {
        _name = [name copy];
    }
    return self;
}

- (void)greet {
    NSLog(@"Hello, %@!", self.name);
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSArray<NSNumber *> *values = @[@1, @2, @3];
        NSInteger total = 0;

        for (NSNumber *value in values) {
            total += value.integerValue;
        }

        NSLog(@"sum = %ld", (long)total);
        [[[Greeter alloc] initWithName:@"Panda"] greet];
    }
    return 0;
}

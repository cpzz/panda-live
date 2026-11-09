#!/usr/bin/env perl
# 示例：子程序、哈希与排序。
use strict;
use warnings;

sub average {
    my @values = @_;
    return 0 unless @values;

    my $sum = 0;
    $sum += $_ for @values;
    return $sum / @values;
}

my %scores = (
    Alice => 95,
    Bob   => 72,
    Cara  => 88,
);

for my $name (sort keys %scores) {
    printf "%-6s %d\n", $name, $scores{$name};
}

printf "平均分：%.2f\n", average(values %scores);

"use strict";
/** 激活超时契约测试：activate 永不 resolve，宿主必须按超时终止并报「激活超时」。 */

module.exports.activate = function activate() {
  return new Promise(() => {
    // 永不 resolve
  });
};

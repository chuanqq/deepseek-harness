# Check-1
- question:
> 搜索相关资料或者推断下 deepseek harness web 界面在 macos 上有时候网页端的输入框无法输入中文输入法的原因可能是？只能输入直接的英文键盘字母？
---

我先搜一下相关的已知问题和讨论，再结合原理给你分析。
这类问题在 CJK（中日韩）输入法场景下非常典型，搜到的资料里有大量同构的 bug 报告（xterm.js、各类 Agent Web UI、React 应用都有）。先把你的症状拆成两类，因为它们的根因不同：

**症状 A：候选条根本不弹出来，按键直接变成英文字母落进输入框**（IME 被整体绕过）
**症状 B：候选条弹出来了，但打着打着组合被中断、拼音直接上屏或 Enter 提前把消息发出去了**

你说的"只能输入英文键盘字母"更像症状 A，但"有时候"三个字提示可能两者都有。下面按可能性排一下原因。

## 最可能的原因：前端把键盘事件拦截了，IME 根本没机会启动

IME 只有在**浏览器原生文本输入路径激活**（焦点在真正的 `<input>` / `<textarea>` / contenteditable 上，且 keydown 没被 `preventDefault()`）时才能开始组合。很多 Web 界面的输入框其实不是"真输入框"：

- **隐藏 textarea + JS 重放字符**的架构（xterm.js 这类终端、Monaco 这类编辑器、canvas 渲染的 UI）。已知 bug 模式是：组合的第一个 keydown **先于** `compositionstart` 到达，此时代码里的 composing 标志还没置位，于是字符走了普通键盘路径被 `preventDefault()` 后以原始拉丁字母发出——IME 被完全旁路，表现就是"只能打英文" 
- **全局快捷键监听**（比如 `/` 唤起命令面板、Enter 发送）挂在 document 上且没有 `e.isComposing || e.keyCode === 229` 守卫，把 IME 的按键事件截胡 
- 如果你的 harness 是 Electron 壳的桌面应用，同样适用——Electron/WebView 应用的输入处理就是 DOM keydown 

## 第二梯队：composition 中途被 React 打断

- **受控组件在组合期间写回 value**：React 的 `onChange` 其实是原生 `input` 事件，组合过程中会频繁触发（打"你好"两个字触发了 9 次 input，其中 8 次是无意义的中间态）。如果 effect 在组合期间把 state 写回 DOM 或重渲染 innerHTML，组合会被浏览器强制中止，候选条一闪就消失 
- **Safari 特有**：Safari 的 composition 事件顺序和 Chrome 不同（确认候选的 Enter 事件时序不一样），在 Chrome 正常的代码到 Safari 上会出现组合中途被打断、Enter 确认候选变成发送消息 。React 还有个怪癖：收到 `keyCode === 229` 的 keydown 时会合成一个假的 `onCompositionStart`，可能吞掉组合后的第一个真实按键 
- **没有 isComposing 守卫的 Enter 发送逻辑**：IME 里按 Enter 确认候选词时浏览器照样发 `key === "Enter"` 的 keydown，如果 handler 不检查组合状态就直接发送——消息带着半截拼音就出去了 

## 第三梯队：macOS 系统层和输入法层（解释"有时候"）

- **Secure Input 卡死**：macOS 上某个 app（密码管理器、登录窗口等）开启安全输入后没正确释放，会导致系统范围内 IME 被禁用，所有地方都只能打英文，切一下 app 或重启相关进程又好了。这是"间歇性全系统只能输英文"的经典原因
- **第三方输入法兼容性**：搜狗、豆包等输入法的英文模式仍然会让每个按键都带 `keyCode=229`（规范允许但很多前端假设 229 很罕见），直接打崩依赖 composition 事件边界的输入逻辑 ；老版本 Chrome/Electron 内核与搜狗也有已知的候选框兼容问题
- **浏览器扩展**：Vimium 这类键盘导航扩展会捕获 keydown，拦截 IME 输入

## 快速定位：三个对照实验

1. **换输入法**：macOS 自带拼音 vs 你现在的输入法。系统输入法正常、第三方不正常 → 输入法兼容问题
2. **换浏览器**：Safari vs Chrome。行为不同 → 前端 composition 事件处理有浏览器依赖 bug 
3. **DevTools 里贴这段**，复现问题看事件流：

```javascript
const el = document.activeElement;
['keydown','compositionstart','compositionupdate','compositionend','input','beforeinput']
  .forEach(t => el.addEventListener(t, e =>
    console.log(t, { key: e.key, keyCode: e.keyCode, isComposing: e.isComposing, data: e.data })));
```

如果打中文时**完全没有** `compositionstart`，只有一串普通 keydown——输入框不是真文本框或按键被拦截（症状 A 确认）；如果有 `compositionstart` 但中途异常结束——受控组件写回或重渲染问题（症状 B）。

另外检查一下焦点：点进输入框后 `document.activeElement` 是什么。如果是个 `div` 而不是 input/textarea/contenteditable，基本可以实锤是隐藏 textarea 架构的按键重放 bug。

## 修复方向（如果这个 harness 是你自己写的）

核心就三条，所有搜到的修复 PR 都是这个模式：

```typescript
// 1. 所有 keydown handler 第一行加守卫
if (e.isComposing || e.keyCode === 229) return;

// 2. 组合期间禁止 value 写回 / innerHTML 重渲染 / setCaret
let composing = false;
el.addEventListener('compositionstart', () => composing = true);
el.addEventListener('compositionend', () => {
  // 用 setTimeout 延迟复位，处理 compositionend 与 keydown 同 tick 的竞态
  setTimeout(() => composing = false, 0);
});

// 3. 发送时从 DOM 实时读文本，别信 React state（组合末尾 state 可能落后）
```

xterm.js 系终端还要额外注意：守卫要在 `compositionstart` 置位**之前**靠 `keyCode === 229` 兜住第一个 keydown 。

如果你说的就是 DeepSeek 官方网页版而非自己的 harness，那代码改不了，实际可用的绕法是：换 macOS 自带输入法、换浏览器复现确认后给官方提 issue（带上第 3 步的事件流日志，这类 issue 有日志基本都能修）、临时在别处打好中文再粘贴。


# Check-2

- Question:
> 我使用的是外部输入法，其他页面正常，就 deepseek harness web 界面出现下面这输入问题，看起来没有触发到输入法本身？
> ```log
> keydown {key: 'Meta', keyCode: 91, isComposing: false, data: undefined}
VM206:4 keydown {key: 'Meta', keyCode: 91, isComposing: false, data: undefined}
VM206:4 keydown {key: 'Alt', keyCode: 18, isComposing: false, data: undefined}
VM206:4 keydown {key: 'Control', keyCode: 17, isComposing: false, data: undefined}
VM206:4 keydown {key: 'Shift', keyCode: 16, isComposing: false, data: undefined}
VM206:4 keydown {key: 'Shift', keyCode: 16, isComposing: false, data: undefined}
VM206:4 keydown {key: 'd', keyCode: 68, isComposing: false, data: undefined}
VM206:4 beforeinput {key: undefined, keyCode: undefined, isComposing: false, data: 'd'}
VM206:4 input {key: undefined, keyCode: undefined, isComposing: false, data: 'd'}
VM206:4 keydown {key: 'd', keyCode: 68, isComposing: false, data: undefined}
VM206:4 beforeinput {key: undefined, keyCode: undefined, isComposing: false, data: 'd'}
VM206:4 input {key: undefined, keyCode: undefined, isComposing: false, data: 'd'}
VM206:4 keydown {key: 'd', keyCode: 68, isComposing: false, data: undefined}
> ```

---

这份日志信息量很大，先说我从中读到的结论，再给下一步的判别实验。

## 日志说明了什么

三个关键证据：

1. **keyCode 是 68（原始的 `d` 键），不是 229（`Process`）**——macOS 上只要中文输入法处于激活状态，按键必须先经过 IME，浏览器收到的 keydown 应该是 229。你这里直接收到原始字母键，说明**操作系统压根没把按键路由给输入法**。
2. **完全没有 `compositionstart`**——不是组合被打断，是组合从未开始。
3. `beforeinput`/`input` 里是 `data: 'd'` 的**原生文本插入**——焦点确实在一个可编辑元素上，浏览器正常落了字符，只是 IME 缺席。

所以上一条回答里那一大类"前端 composition 处理 bug"（isComposing 守卫、React 写回、Enter 提前发送）**全部排除**——问题发生在更底层：这个输入框被创建成了一个"不接受 IME"的文本上下文，或者输入法自己决定不接管。剩下三类嫌疑，各配一个判别实验。

## 嫌疑一：输入框的类型是 ASCII-only / 安全类

Chromium 在 macOS 上对 `type="password"`、`email`、`url`、`number`、`tel` 这类输入框会创建 **ASCII-capable 的输入上下文，直接禁用 IME**——这是有据可查的已知行为，mac Chrome 上 `type="email"` 的框里打不出中文是老问题。一个"只能打英文、候选条不出现"的输入框，这是第一嫌疑人。而且这个 harness 界面如果有什么 token/key 配置框，很可能就是 password 类型。

**判别**：焦点在输入框里时，Console 执行：

```javascript
const el = document.activeElement;
console.log({
  tag: el.tagName, type: el.type,
  contentEditable: el.isContentEditable,
  inputmode: el.getAttribute('inputmode'),
  autocomplete: el.getAttribute('autocomplete'),
  inShadowDOM: el.getRootNode() !== document,
  html: el.outerHTML.slice(0, 300)
});
```

如果 `type` 是 `password` / `email` / `url` / `number` / `tel`——实锤，IME 是被 Chromium 按规范禁掉的，只有改元素类型才能解决。

## 嫌疑二：第三方输入法对这个上下文误判

你用的是第三方输入法，而**系统自带拼音正常、第三方失灵**是这个类目的典型特征。搜狗等输入法有"智能英文""终端/代码场景自动切英文"之类的上下文检测（通过 Accessibility API 读焦点元素的角色），在特定页面元素上会误判，主动放行按键走英文直通——表现也是"候选条不出现、字母直落"，且和页面强相关。

**判别**：不动页面，只切到 **macOS 自带拼音**，在同一个输入框打字：
- 自带拼音能打中文 → 实锤是第三方输入法的上下文误判。解法：检查输入法的 per-app 规则/智能英文设置，升级或更换输入法，给它提 bug。
- 自带拼音也打不了 → 回到嫌疑一或三，问题在页面或系统层。

## 嫌疑三：macOS 把英文输入法"记住"并自动切回来了

macOS 有个"**自动切换到文稿的输入法**"机制（系统设置 → 键盘 → 输入法），它会记住你上次在某个文档/页面用的输入源，下次焦点回去时自动切回。如果你曾经在这个页面处于 ABC/英文输入源，之后每次聚焦它都会被静默切回英文——**菜单栏图标可能还显示着中文输入法的图标，但实际输入源已经是 ABC**，第三方输入法在这种切换下尤其容易表现异常。这能完美解释"有时候"三个字。

**判别**：复现问题时看一眼**菜单栏的输入法图标**到底显示的是"中/拼"还是"ABC/A"。是后者 → 去系统设置关掉"自动切换到文稿的输入法"，然后手动切回中文即可。

另一个同层级的"有时候"因素是 Secure Input：某个进程（密码管理器、登录窗口，或页面里一个隐藏的 password 字段触发了 Chrome 开启安全输入）挂着没释放时，**整个 app 的 IME 都会被禁用**。如果怀疑这个，重启浏览器进程能立刻验证。

## 结论分支

跑完上面三个判别（元素类型 → 换自带输入法 → 看菜单栏图标），基本必中其一：

| 结果 | 根因 | 处理 |
|---|---|---|
| `type` 是 password/email/url 等 | Chromium 对该类型禁用 IME | 页面 bug，给 harness 作者提 issue：输入框应改为 `type="text"` |
| 自带拼音正常、第三方不行 | 输入法上下文误判 | 输入法侧设置/升级/更换 |
| 菜单栏图标变成 ABC | macOS 自动切换文稿输入法 | 关闭该系统选项 |
| 重启浏览器后恢复 | Secure Input 悬挂 | 找出挂着的进程 |

如果查出来这个 harness 是你自己维护的前端，顺手确认一件事：有没有逻辑在 focus 后立即 `blur()`/重新挂载输入框——焦点快速重建会把 macOS 的输入上下文反复销毁，按键就会以这种"IME 缺席、字母直落"的方式漏进来。但先跑判别实验，日志已经告诉我们答案就在这三类里。

# Check-3

- Question

> 1. 新开一个普通网页的标签页，测试中文输入 IME 正常
> 2. 没有
> 3. 不能恢复
> 4. 发送一条消息后就会这样
> 
> 注意，我使用的 chrome install 的网页应用，直接在网页端进行访问是正常的

"PWA 独立窗口里才坏、普通标签页正常"这条信息是决定性的——我先快速搜一下 Chromium 在这块的已知问题，再给你收敛结论。
拼图完整了。"Chrome 安装的网页应用（PWA）里才坏、直接网页访问正常"这条把结论钉死了——这不是你的输入法或系统设置问题，是 **Chromium PWA 窗口在 macOS 上的输入法上下文缺陷，被这个页面"发送消息"的动作触发**。

## 最终机制解释

macOS 上 Chrome 安装的 PWA 不是普通标签页，它以独立的 app shim 运行——**独立的进程、独立的窗口、独立的文本输入上下文**。这解释了你的全部观察：

- 发送一条消息 → 页面执行"清空 textarea → 发送期间禁用/重建 → 流式结束后重新聚焦"这一连串操作（这是聊天界面的标准动作，也是已知的 IME 杀手模式——同样的"发送后清空并重新聚焦"序列在 iOS 上能把 React 聊天应用的 IME 直接打死 ）
- 在普通标签页里，这套操作后的输入上下文重建走的是成熟路径，没事
- 在 PWA app shim 窗口里，这个重建过程有缺陷：TSM 上下文在**视图/窗口层**卡死——所以元素层的 blur/refocus 救不回来（坏的不是元素），新开的普通标签页正常（那是主 Chrome 进程的另一个视图），只有重启 PWA 进程或刷新窗口能重建上下文
- 卡死后按键不再路由给 IME，macOS 按 ASCII 直投——keyCode 68、无 229、无 composition，和你抓的日志严丝合缝
- 第三方输入法比系统拼音更容易在这种上下文异常里死掉，所以"其他页面正常"的假象更明显

责任分配：**页面是扳机，PWA 壳是卡死发生的地方**。Chrome 对所有顶层窗口的 IME 状态做进程内统一管理而非窗口级独立管理，这是它的架构选择 ，PWA 窗口的这套路径测试覆盖远不如普通标签页。

## 还剩一个判别实验（对提 issue 很关键）

在 PWA 窗口**坏掉的状态下**，切到 macOS 自带拼音打一下：

- 自带拼音能用、第三方输入法死了 → 卡死发生在第三方输入法的 TSM 客户端侧，issue 该提给输入法厂商
- 自带拼音也死了 → 卡死在 Chromium 的视图层，issue 提给 Chromium（crbug.com，关键词：PWA app window、macOS、IME、text input context）和 harness 项目方

## 实际可用的应对

1. **最省事**：直接用普通标签页访问（你已验证正常），把 PWA 卸载或留着应急
2. **要用 PWA**：坏掉时在 PWA 窗口里 `Cmd+R` 刷新窗口试试——只重建这一个视图，不用退出整个浏览器，成本远低于重启
3. 顺手抓一个铁证给开发者：发送消息前后在 Console 跑

```javascript
const ta = document.querySelector('textarea');
console.log('发送前:', { disabled: ta.disabled, focused: document.activeElement === ta });
// 点发送，流式输出结束后再看一次，或在 textarea 上挂 MutationObserver 观察 disabled 属性变化
new MutationObserver(ms => ms.forEach(m =>
  console.log('属性变化:', m.attributeName, 'disabled =', ta.disabled))
).observe(ta, { attributes: true });
```

如果日志里出现 `disabled` 从 true 弹回 false、或 textarea 节点被整个替换，那就是扳机动作本身。

## 如果这个 harness 是你自己写的

根治就一条原则：**发送/流式期间不要对聚焦中的 textarea 做 `disabled` 切换或节点重建**。改用 `aria-disabled` + CSS 置灰 + JS 层拦截发送，视觉上是禁用但 DOM 上下文不动；必须重新聚焦的话，包在 `requestAnimationFrame` 里做，让浏览器先完成一轮布局。这个写法在所有平台（包括 iOS 那个 React bug ）都是安全的。


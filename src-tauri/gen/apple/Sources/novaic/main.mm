#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// 全局持有找到的 WKWebView 引用
static __unsafe_unretained WKWebView *g_webView = nil;

// ── 递归查找 WKWebView ──────────────────────────────────────────────────────
static WKWebView* findWebViewInView(UIView *view) {
    if ([view isKindOfClass:[WKWebView class]]) {
        return (WKWebView *)view;
    }
    for (UIView *sub in view.subviews) {
        WKWebView *found = findWebViewInView(sub);
        if (found) return found;
    }
    return nil;
}

static WKWebView* findWebView(void) {
    UIWindowScene *scene = nil;
    for (UIScene *s in UIApplication.sharedApplication.connectedScenes) {
        if ([s isKindOfClass:[UIWindowScene class]]) {
            scene = (UIWindowScene *)s;
            break;
        }
    }
    if (!scene) return nil;
    for (UIWindow *window in scene.windows) {
        WKWebView *wv = findWebViewInView(window);
        if (wv) return wv;
    }
    return nil;
}

// ── 配置 WKWebView：移除键盘通知 + 注册自己的键盘监听 ──────────────────────
static void configureWebView(WKWebView *webView) {
    UIScrollView *scrollView = webView.scrollView;

    // 1. 禁用弹性 + 防止弹跳
    scrollView.bounces = NO;

    // 2. 移除 WKWebView/scrollView 上的键盘通知观察者
    //    这阻止 iOS 在键盘弹出时自动滚动页面 → Header 保持固定
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    NSArray *names = @[
        UIKeyboardWillShowNotification,
        UIKeyboardWillHideNotification,
        UIKeyboardWillChangeFrameNotification,
        UIKeyboardDidChangeFrameNotification
    ];
    for (NSNotificationName name in names) {
        [nc removeObserver:webView name:name object:nil];
        [nc removeObserver:scrollView name:name object:nil];
    }

    NSLog(@"[KeyboardFix] WKWebView observers removed, bounces=NO");
}

// ── 注入键盘高度到 WebView 的 CSS 变量 ──────────────────────────────────────
static void injectKeyboardHeight(WKWebView *webView, CGFloat height) {
    NSString *js = [NSString stringWithFormat:
        @"document.documentElement.style.setProperty('--keyboard-height','%.0fpx')", height];
    [webView evaluateJavaScript:js completionHandler:nil];
    NSLog(@"[KeyboardFix] Injected --keyboard-height: %.0fpx", height);
}

// ── 注册我们自己的键盘通知监听 ──────────────────────────────────────────────
static void registerKeyboardObservers(void) {
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];

    // 键盘将要显示
    [nc addObserverForName:UIKeyboardWillShowNotification object:nil queue:nil
        usingBlock:^(NSNotification *note) {
            CGRect frame = [note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
            CGFloat kbHeight = frame.size.height;
            WKWebView *wv = g_webView;
            if (wv) {
                injectKeyboardHeight(wv, kbHeight);
                // 强制 contentOffset 回零（防止残留滚动）
                [wv.scrollView setContentOffset:CGPointZero animated:NO];
            }
        }];

    // 键盘将要隐藏
    [nc addObserverForName:UIKeyboardWillHideNotification object:nil queue:nil
        usingBlock:^(NSNotification *note) {
            WKWebView *wv = g_webView;
            if (wv) {
                injectKeyboardHeight(wv, 0);
                [wv.scrollView setContentOffset:CGPointZero animated:NO];
            }
        }];

    // 键盘 frame 变化（切换输入法等）
    [nc addObserverForName:UIKeyboardWillChangeFrameNotification object:nil queue:nil
        usingBlock:^(NSNotification *note) {
            CGRect frame = [note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
            CGFloat screenHeight = UIScreen.mainScreen.bounds.size.height;
            CGFloat kbHeight = screenHeight - frame.origin.y;
            if (kbHeight < 0) kbHeight = 0;
            WKWebView *wv = g_webView;
            if (wv) {
                injectKeyboardHeight(wv, kbHeight);
                [wv.scrollView setContentOffset:CGPointZero animated:NO];
            }
        }];

    NSLog(@"[KeyboardFix] Keyboard observers registered");
}

// ── 应用修复 ────────────────────────────────────────────────────────────────
static void applyFix(void) {
    WKWebView *wv = findWebView();
    if (!wv) {
        NSLog(@"[KeyboardFix] WKWebView not found yet");
        return;
    }
    g_webView = wv;
    configureWebView(wv);
}

int main(int argc, char * argv[]) {
    // 注册键盘监听（全局，只需一次）
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        registerKeyboardObservers();
    });

    // 延迟查找并配置 WKWebView（Tauri 创建后）
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        applyFix();
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        applyFix();
    });
    // OTA 导航后重新配置
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        applyFix();
    });

    // 启动 Tauri — 进入 UIKit run loop，不返回
    ffi::start_app();
    return 0;
}

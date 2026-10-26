// 和本地服务（host/bili_host.py）通信。每次调用开一个连接，浏览器按需启动本地服务，调用完就关掉。
export const HOST = 'com.leinaldo.bili_obsidian';

export function hostCall(cmd, payload = {}, onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(new Error('连不上本地服务：' + e.message));
    }
    let done = false;
    port.onMessage.addListener(m => {
      if (m.type === 'progress') return onProgress?.(m.msg);
      done = true;
      port.disconnect();
      m.type === 'result' ? resolve(m) : reject(new Error(m.error));
    });
    port.onDisconnect.addListener(() => {
      if (done) return;
      const err = chrome.runtime.lastError?.message || '';
      reject(new Error(/not found|not registered|forbidden/i.test(err)
        ? '没装本地服务，或安装后没重启浏览器。运行安装脚本后重启浏览器'
        : '本地服务意外退出：' + err));
    });
    port.postMessage({ id: 1, cmd, ...payload });
  });
}

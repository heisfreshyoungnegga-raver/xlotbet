/**
 * Halopesa MiniApp Platform SDK
 * Version: 1.0.0  (message-receiver hardening)
 *
 * 基于 sdk-communication.service.ts 源码 + 官方文档封装
 * 纯 IIFE，无框架依赖，Vue2 / Vue3 / 原生 JS 通用
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本版本相对 1.0.0 的修复（解决第三方反映"监听 hostapp 消息时好时坏"）：
 *   1. 监听器注册与 URL 参数 channel_platform 解耦：页面加载即注册接收器，
 *      不再因缺少 URL 参数而完全不监听。
 *   2. 所有平台都同时注册 全局 window.miniappSdkToWebview + postMessage 监听，
 *      不再出现 iOS/Flutter 只有全局函数、Android/WEB 才有 postMessage 的差异。
 *   3. 新增 bridge-ready 轮询：原生 bridge 注入较晚时自动补注册 RN/Android 通道。
 *   4. RN 通道不再硬依赖 window.invoke 立即存在；就绪后自动补挂。
 *   5. 收到真实 SDK 消息时自动确认平台（即使缺少 URL 参数也能恢复发送能力）。
 *   6. getPlatform() 缓存已探测到的平台，避免瞬时 null 打断 sendToSdk。
 * 仅改动通信接收层，登录 / 支付逻辑保持不变。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 核心流程：WebView 加载 → 原生端自动推送 INIT（含 phone/username）→ 缓存 → 用户点击登录 → 读缓存调后端
 *
 * 使用方式:
 *   <script src="/static/utils/halopesa-sdk.js?v=1.0.0"></script>
 *   <script>
 *     // 登录
 *     HalopesaSDK.fullLoginFlow(backendApi).then(...)
 *     // 支付
 *     HalopesaSDK.startPayment({ createOrderApi, ... }).then(...)
 *     // 检测环境
 *     if (HalopesaSDK.isHalopesaApp()) { ... }
 *   </script>
 */
;(function (global) {
  'use strict'

  // =====================================================================
  //  config - 配置常量
  // =====================================================================
  const SDK_PLATFORM = {
    REACT_NATIVE: 'REACT_NATIVE',
    FLUTTER: 'FLUTTER',
    ANDROID: 'ANDROID',
    IOS: 'IOS',
    WEB: 'WEB',
    MOCK: 'MOCK',
    LOCAL: 'LOCAL',
    HOME: 'HOME',
  }

  const SDK_SENDER = {
    WEBVIEW: 'MINIAPP_WEBVIEW',
    SDK: 'MINIAPP_SDK',
  }

  const SDK_EVENT_CODES = {
    SUCCESS: 'SDK000',
    GENERAL_ERROR: 'SDK001',
    PERMISSION_DENIED: 'SDK002',
    INVALID_REQUEST: 'SDK003',
  }

  const REQUEST_ID_PREFIX = 'MINIAPP_'
  const SDK_INIT_TIMEOUT_MS = 30000    // INIT 等待超时（原生自动推送，允许较长延迟）
  const SDK_API_TIMEOUT_MS = 60000     // API 请求超时（分钟级，权限弹窗可能慢）
  const INIT_STORAGE_KEY = '__halopesaInitData__'  // localStorage key，跨 reload + 跨 APP 退出重进 持久化 INIT

  // bridge-ready 轮询配置（原生 bridge 注入较晚时用于补注册通道）
  const BRIDGE_WATCH_INTERVAL_MS = 200
  const BRIDGE_WATCH_MAX_ATTEMPTS = 50  // 约 10 秒

  const SDK_EVENTS = {
    INIT: 'INIT',
    INIT_REQUEST: 'INIT_REQUEST',
    INIT_CHANNEL: 'INIT_CHANNEL',
    API_REQUEST: 'API_REQUEST',
    API_RESPONSE: 'API_RESPONSE',
    PAYMENT_REQUEST: 'PAYMENT_REQUEST',
    INIT_PAYMENT: 'INIT_PAYMENT',
    PAYMENT_START: 'PAYMENT_START',
    PAYMENT_BACK_TO_MINIAPP: 'PAYMENT_BACK_TO_MINIAPP',
    EVENT_PAYMENT_SUCCESS: 'EVENT_PAYMENT_SUCCESS',
    EVENT_PAYMENT_FAIL: 'EVENT_PAYMENT_FAIL',
    NOTIFY_PAYMENT: 'NOTIFY_PAYMENT',
    LOGIN_SUCCESS: 'LOGIN_SUCCESS',
    LOGIN_ANONYMOUS: 'LOGIN_ANONYMOUS',
    EXPIRED_SESSION: 'EXPIRED_SESSION',
    CLEAR_SESSION: 'CLEAR_SESSION',
    EXCHANGE_KEY: 'EXCHANGE_KEY',
    ENCRYPT_DATA: 'ENCRYPT_DATA',
    DECRYPT_DATA: 'DECRYPT_DATA',
    EXIT: 'EXIT',
    APP_OPEN_STORE: 'APP_OPEN_STORE',
    APP_OPEN_WEBVIEW: 'APP_OPEN_WEBVIEW',
    OPEN_EXTERNAL_LINK: 'OPEN_EXTERNAL_LINK',
    NAVIGATE_TAB: 'NAVIGATE_TAB',
    REQUEST_CONTACTS_PERMISSION: 'REQUEST_CONTACTS_PERMISSION',
    CHECK_CONTACTS_PERMISSION: 'CHECK_CONTACTS_PERMISSION',
    CHECK_LOCATION_PERMISSION: 'CHECK_LOCATION_PERMISSION',
    REQUEST_LOCATION_PERMISSION: 'REQUEST_LOCATION_PERMISSION',
    GET_LOCATION: 'GET_LOCATION',
    OPEN_PHONE_CALL: 'OPEN_PHONE_CALL',
    APP_WRITE_CLIPBOARD: 'APP_WRITE_CLIPBOARD',
    SHARE_BILL: 'SHARE_BILL',
    SAVE_IMAGE_TO_GALLERY: 'SAVE_IMAGE_TO_GALLERY',
    CONTACTS: 'CONTACTS',
    DEVICE_CONFIG: 'DEVICE_CONFIG',
    OPEN_NAPAS: 'OPEN_NAPAS',
    OPEN_KEYBOARD: 'OPEN_KEYBOARD',
    EKYC_START: 'EKYC_START',
    BANNER_TOPUP: 'BANNER_TOPUP',
    IN_FOREGROUND: 'IN_FOREGROUND',
    HOST_APP_ON_ACTIVE: 'HOST_APP_ON_ACTIVE',
  }

  const EXIT_ACTIONS = {
    STAY_CURRENT: 'STAY_CURRENT',
    RETURN_HOME: 'RETURN_HOME',
    OPEN_QR_SCAN: 'OPEN_QR_SCAN',
  }

  const SDK_PERMISSIONS = {
    LOGIN: 'LOGIN_PERMISSION',
    PHONE_NUMBER: 'USER_PHONE_NUMBER_PERMISSION',
    USER_NAME: 'USER_NAME_PERMISSION',
    FULL_NAME: 'USER_FULL_NAME_PERMISSION',
    AVATAR: 'USER_AVATAR_PERMISSION',
    AGE: 'USER_AGE_PERMISSION',
    BIRTH_DATE: 'USER_BIRTH_DATE_PERMISSION',
    GENDER: 'USER_GENDER_PERMISSION',
    NATIONAL_ID: 'USER_NATIONAL_ID_PERMISSION',
    LOCATION: 'LOCATION_PERMISSION',
    CAMERA: 'CAMERA_PERMISSION',
    CONTACT: 'CONTACT_PERMISSION',
    LOCAL_AUTH: 'LOCAL_AUTHENTICATION_PERMISSION',
  }

  const API_PATHS = {
    oauthLogin: '/ewallet3/client-gateway/oauth/client-login',
    paymentInit: '/ewallet3/ewallet-business-adapter/api/v1/miniapp/transfer/w2w/init',
    paymentConfirm: '/ewallet3/ewallet-business-customer/api/v1/app/transfer/w2w/confirm',
    transactionInquiry: '/ewallet3/ewallet-business-adapter/api/v1/miniapp/transaction/inquiry',
  }

  const TRANSACTION_STATUS = {
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    PROCESSING: 'PROCESSING',
    PENDING_RECONCILIATION: 'PENDING_RECONCILIATION',
    CANCELLED: 'CANCELLED',
    CONFIRMED: 'CONFIRMED'
  }

  const INQUIRY_RETRY_POLICY = [
    { attempt: 1, delay: 2000 },
    { attempt: 2, delay: 3000 },
    { attempt: 3, delay: 5000 },
    { attempt: 4, delay: 10000 },
    { attempt: 5, delay: 15000 },
  ]

  // =====================================================================
  //  sdk - SDK 通信层
  // =====================================================================

  // 事件总线
  function SdkEventBus() {
    this._listeners = new Map()
  }
  SdkEventBus.prototype.on = function (event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set())
    }
    this._listeners.get(event).add(callback)
    var self = this
    return function () { self.off(event, callback) }
  }
  SdkEventBus.prototype.off = function (event, callback) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).delete(callback)
    }
  }
  SdkEventBus.prototype.emit = function (event, data) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).forEach(function (cb) {
        try { cb(data) } catch (e) {}
      })
    }
  }

  var eventBus = new SdkEventBus()

  // 平台检测（源码 init() switch-case 逻辑）
  function detectPlatform() {
    if (window.AndroidWebview && typeof window.AndroidWebview.miniappWebviewToSdk === 'function') {
      return SDK_PLATFORM.ANDROID
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.miniappWebviewToSdk) {
      return SDK_PLATFORM.IOS
    }
    if (window.flutter_inappwebview && typeof window.flutter_inappwebview.callHandler === 'function') {
      return SDK_PLATFORM.FLUTTER
    }
    if (window.__REACT_NATIVE_WEBVIEW_INVOKE__ || window.invoke) {
      return SDK_PLATFORM.REACT_NATIVE
    }
    if (window.parent && window.parent !== window) {
      return SDK_PLATFORM.WEB
    }
    return null
  }

  // ★ Fix 6: 缓存已探测到的平台，避免 SPA / bridge 抖动导致瞬时 null 打断 sendToSdk
  var _cachedPlatform = null
  function _resolvePlatform() {
    var p = detectPlatform()
    if (p) { _cachedPlatform = p }
    return p || _cachedPlatform
  }

  // Halopesa 渠道标识（URL query 参数，第三方确认 key 名）
  var HALOPESA_CHANNEL_PARAM = 'channel_platform'
  var HALOPESA_CHANNEL_VALUE = 'Halopesa'
  var HALOPESA_CONFIRMED_KEY = '__halopesaPlatformConfirmed__'  // localStorage key（跨 reload + 跨 APP 退出重进持久化）

  // 从 localStorage 读取确认标记（跨 reload + 跨 APP 退出重进持久化）
  function _isPlatformConfirmed() {
    try { return localStorage.getItem(HALOPESA_CONFIRMED_KEY) === '1' } catch(e) { return false }
  }
  function _setPlatformConfirmed() {
    try {
      localStorage.setItem(HALOPESA_CONFIRMED_KEY, '1')
    } catch(e) {
    }
  }

  // getPlatform：仅用于判断"是否可以主动发送"，返回 null 表示尚未确认渠道。
  // ★ 注意：接收监听器的注册已与本函数解耦（见 _registerUniversalReceiver / _earlyInit），
  //   即使这里返回 null，SDK 仍在监听 host 推送的消息。
  function getPlatform() {
    var platform = _resolvePlatform()
    if (_isPlatformConfirmed()) {
      return platform
    }
    if (!platform) {
      return null
    }
    // 必须有 Halopesa 渠道标识才建立通信（防止其它 APP/WebView 误判）
    var search = window.location.search || ''
    var params = new URLSearchParams(search)
    var channelParam = params.get(HALOPESA_CHANNEL_PARAM)
    if (channelParam === HALOPESA_CHANNEL_VALUE) {
      _setPlatformConfirmed()
      return platform
    }
    // fallback: 某些 WebView 场景 window.location.search 可能为空，检查完整 href
    if (window.location.href && window.location.href.indexOf('channel_platform=Halopesa') !== -1) {
      _setPlatformConfirmed()
      return platform
    }
    return null
  }

  function isHalopesaApp() {
    return getPlatform() !== null
  }

  function isNativeApp() {
    var platform = _resolvePlatform()
    return platform !== null && platform !== SDK_PLATFORM.WEB
  }

  function genRequestId() {
    return REQUEST_ID_PREFIX + Date.now()
  }

  function isMatchedResponse(response, request) {
    return response && response.sender === SDK_SENDER.SDK
      && (!request || (request && request.request_id === response.request_id))
  }

  function buildRequest(event, data) {
    return {
      event: event,
      sender: SDK_SENDER.WEBVIEW,
      request_id: genRequestId(),
      data: data || null,
    }
  }

  function sendViaBridge(platform, request) {
    var json = JSON.stringify(request)
    var sent = false
    try {
      switch (platform) {
        case SDK_PLATFORM.ANDROID:
          if (window.AndroidWebview && typeof window.AndroidWebview.miniappWebviewToSdk === 'function') {
            window.AndroidWebview.miniappWebviewToSdk(json)
            sent = true
          }
          var invoke = window.invoke || window.__REACT_NATIVE_WEBVIEW_INVOKE__
          if (invoke && typeof invoke.bind === 'function') {
            try {
              var sendToSdk = invoke.bind('miniappWebviewToSdk')
              if (sendToSdk) { sendToSdk(request); sent = true }
            } catch(e) {}
          }
          break
        case SDK_PLATFORM.IOS:
          window.webkit.messageHandlers.miniappWebviewToSdk.postMessage(json)
          sent = true
          break
        case SDK_PLATFORM.FLUTTER:
          window.flutter_inappwebview.callHandler('miniappWebviewToSdk', request)
          sent = true
          break
        case SDK_PLATFORM.REACT_NATIVE: {
          var invoke = window.invoke || window.__REACT_NATIVE_WEBVIEW_INVOKE__
          if (invoke && typeof invoke.bind === 'function') {
            var sendToSdk = invoke.bind('miniappWebviewToSdk')
            if (sendToSdk) { sendToSdk(request); sent = true; break }
          }
          break
        }
        case SDK_PLATFORM.WEB:
          window.parent.postMessage(json, '*')
          sent = true
          break
      }
    } catch(e) {}
    return sent
  }

  var _webMessageHandler = null
  var _sdkToWebviewHandler = null

  // 统一规范化：原生下发的真实结构是嵌套的
  //   NOTIFY_PAYMENT: { data: { event, data: { status, ... }, sender, request_id }, message, eventStatus }
  //   INIT:           { data: { event, external: {...}, internal: {...}, sender, request_id }, message, eventStatus }
  // 展平到顶层 { event, data, sender, request_id, eventStatus, _raw, ... }
  // 关键：NOTIFY_PAYMENT 的 payload 在 inner.data 里，但 INIT 的 payload（external/internal）直接挂在 inner 同级
  // 所以当 inner.data 不存在时，用 inner 本身作为 data，避免丢失 INIT 的 external/internal 字段
  function _normalizeSdkMessage(response) {
    if (response && response.data && response.data.event && !response.event) {
      var inner = response.data
      return {
        event: inner.event,
        data: inner.data != null ? inner.data : inner,
        sender: inner.sender || response.sender,
        request_id: inner.request_id,
        eventStatus: response.eventStatus,
        message: response.message,
        _raw: response,
      }
    }
    return response
  }

  // ★ Fix 5: 收到真实 SDK 消息时自动确认平台（缺少 URL 参数也能恢复发送能力）
  function _autoConfirmPlatformFrom(response) {
    if (!response || response.sender !== SDK_SENDER.SDK) return
    if (_isPlatformConfirmed()) return
    if (_resolvePlatform()) { _setPlatformConfirmed() }
  }

  // 统一的"收到消息 → 派发"处理，供全局函数通道 / postMessage 通道 / RN 通道共用，
  // 保证三条接收路径行为完全一致（此前 postMessage 路径缺少 支付结果写全局 + 广播子帧）
  function _emitIncoming(response) {
    // 确保 sender 字段存在（原生可能不传）
    if (response && !response.sender) {
      response.sender = SDK_SENDER.SDK
    }

    _autoConfirmPlatformFrom(response)

    eventBus.emit('sdk:message', response)
    eventBus.emit('sdk:response', response)

    // ★ 将支付结果写入全局变量，供子 iframe（xlotPay）轮询读取
    if (response && response.event === SDK_EVENTS.NOTIFY_PAYMENT) {
      window.__halopesaPaymentResult = response
    }

    // 广播到所有子 iframe（如 xlotPay），让它们在自己 frame 内处理
    _broadcastToFrames(response)
  }

  // 统一的消息处理函数（全局函数通道 / RN 通道：原生直接调用，参数为 string 或 object）
  function _makeSdkToWebviewHandler() {
    if (_sdkToWebviewHandler) return _sdkToWebviewHandler
    _sdkToWebviewHandler = function (rawMsg) {
      var response
      try {
        if (typeof rawMsg === 'undefined' || rawMsg === null) {
          response = { event: 'UNKNOWN', sender: SDK_SENDER.SDK, data: null, _raw: String(rawMsg) }
        } else if (typeof rawMsg === 'string') {
          response = JSON.parse(rawMsg)
        } else {
          response = rawMsg
        }
      } catch(e) {
        response = { event: 'RAW_STRING', sender: SDK_SENDER.SDK, data: String(rawMsg), _parseError: e.message }
      }

      // 规范化（嵌套结构展平到顶层）
      response = _normalizeSdkMessage(response)

      // 记录原生消息
      console.log('[Halopesa SDK] <<< event=' + (response && response.event) +
        ', raw=' + (typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg)))

      _emitIncoming(response)
    }
    return _sdkToWebviewHandler
  }

  // 将原生消息广播到所有子 iframe
  // postMessage 是跨 frame 通信的标准方式，不会触发本帧的 message 监听器
  function _broadcastToFrames(msg) {
    try {
      var payload = JSON.stringify(msg)
      var frames = window.frames
      for (var i = 0; i < frames.length; i++) {
        try { frames[i].postMessage(payload, '*') } catch(e) {}
      }
    } catch(e) {}
  }

  // =====================================================================
  //  ★ 接收器注册（本次重构核心）
  //  与平台探测 / URL 参数彻底解耦：页面加载即注册"全部接收通道"，
  //  原生可用任意一条通道下发消息，均能被捕获。
  // =====================================================================

  var _receiverRegistered = false
  var _bridgeWatchStarted = false

  // postMessage 通道：WEB 场景以及"通过 postMessage 下发"的 native host 都走这里
  function _ensureWebMessageListener() {
    if (_webMessageHandler) return
    _webMessageHandler = function (event) {
      var d = event && event.data
      var response = null
      if (typeof d === 'string') {
        try { response = JSON.parse(d) } catch (e) { return /* 非 JSON，忽略 */ }
      } else if (d && typeof d === 'object') {
        response = d
      }
      if (response && response.sender === SDK_SENDER.SDK) {
        _emitIncoming(_normalizeSdkMessage(response))
      }
    }
    try { window.addEventListener('message', _webMessageHandler) } catch(e) {}
  }

  // 全局函数通道：Android(evaluateJavascript) / iOS / Flutter 均通过调用
  // window.miniappSdkToWebview(...) 下发消息；Android 还可能走 AndroidWebview 命名空间
  function _ensureGlobalFnChannel() {
    var handler = _makeSdkToWebviewHandler()
    try { window.miniappSdkToWebview = handler } catch(e) {}
    try {
      if (window.AndroidWebview) {
        window.AndroidWebview.miniappSdkToWebview = handler
      }
    } catch(e) {}
  }

  // React Native invoke 通道：bridge 就绪后补挂（不硬依赖 window.invoke 立即存在）
  function _tryRegisterRnReceiver() {
    var invoke = window.invoke || window.__REACT_NATIVE_WEBVIEW_INVOKE__
    if (invoke && typeof invoke.define === 'function' && !invoke.__halopesaDefined) {
      try {
        invoke.define('miniappSdkToWebview', _makeSdkToWebviewHandler())
        invoke.__halopesaDefined = true
      } catch(e) {}
    }
  }

  // ★ Fix 1 & 2：一次性注册"全部接收通道"，与平台/URL 参数无关，且幂等
  function _registerUniversalReceiver() {
    _ensureGlobalFnChannel()
    _ensureWebMessageListener()
    _tryRegisterRnReceiver()
    _startBridgeReadyWatch()
    _receiverRegistered = true
  }

  // ★ Fix 3 & 4：bridge-ready 轮询——原生 bridge 注入较晚时自动补注册 RN/Android 通道
  function _startBridgeReadyWatch() {
    if (_bridgeWatchStarted) return
    _bridgeWatchStarted = true
    var attempts = 0
    var timer = setInterval(function () {
      attempts++
      // RN bridge 可能此刻才就绪
      _tryRegisterRnReceiver()
      // AndroidWebview 命名空间可能此刻才注入
      try {
        if (window.AndroidWebview && window.AndroidWebview.miniappSdkToWebview !== _makeSdkToWebviewHandler()) {
          window.AndroidWebview.miniappSdkToWebview = _makeSdkToWebviewHandler()
        }
      } catch(e) {}
      // 全局函数若被 host 页面覆盖，补回
      try {
        if (window.miniappSdkToWebview !== _makeSdkToWebviewHandler()) {
          window.miniappSdkToWebview = _makeSdkToWebviewHandler()
        }
      } catch(e) {}

      if (attempts >= BRIDGE_WATCH_MAX_ATTEMPTS) {
        clearInterval(timer)
      }
    }, BRIDGE_WATCH_INTERVAL_MS)
  }

  // 兼容旧签名：所有调用点（sdkInit / requestInit / halopesaLogin）仍可调用 registerSdkCallback，
  // 现在统一走通用接收器注册（平台参数已不再需要，保留以兼容）
  function registerSdkCallback(platform) {
    _registerUniversalReceiver()
  }

  function sendToSdk(event, data, noResponse) {
    var platform = getPlatform()
    if (!platform) {
      return Promise.reject(new Error('Not running in the Halopesa App environment'))
    }
    var request = buildRequest(event, data)
    if (noResponse) {
      var sent = sendViaBridge(platform, request)
      if (!sent) {
        return Promise.reject(new Error('Failed to send to native bridge (platform: ' + platform + ')'))
      }
      return Promise.resolve({
        request_id: request.request_id,
        sender: SDK_SENDER.SDK,
        event: 'IGNORE',
        data: null,
      })
    }
    return new Promise(function (resolve, reject) {
      var responded = false
      var timeout = setTimeout(function () {
        if (!responded) {
          cleanup()
          reject(new Error('SDK communication timed out: no response received'))
        }
      }, SDK_API_TIMEOUT_MS)
      var handler = function (response) {
        if (isMatchedResponse(response, request)) {
          responded = true
          cleanup()
          var code = response && response.eventStatus ? response.eventStatus.errorCode : undefined
          if (code === SDK_EVENT_CODES.SUCCESS) {
            resolve(response)
          } else {
            reject({
              code: code,
              messageVN: response && response.eventStatus ? response.eventStatus.errorMessageVN : undefined,
              messageEN: response && response.eventStatus ? response.eventStatus.errorMessageEN : undefined,
              raw: response,
            })
          }
        }
      }
      var unsubResponse = eventBus.on('sdk:response', handler)
      function cleanup() { clearTimeout(timeout); unsubResponse() }
      sendViaBridge(platform, request)
    })
  }

  var _initialized = false
  var _initData = null
  var _bridgeRegistered = false
  var _initReady = false
  var _onInitReadyCallbacks = []
  var _initRequested = false  // 标记是否主动发送过 INIT_REQUEST

  // localStorage 持久化：跨 window.location.reload() + 跨 APP 退出重进 恢复 INIT 数据（含 linkToken/phone/username）
  function _saveInitToStorage(data) {
    try {
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        localStorage.setItem(INIT_STORAGE_KEY, JSON.stringify(data))
      }
    } catch(e) { /* localStorage 不可用时静默降级 */ }
  }
  function _loadInitFromStorage() {
    try {
      var raw = localStorage.getItem(INIT_STORAGE_KEY)
      if (raw) { return JSON.parse(raw) }
    } catch(e) {}
    return null
  }

  // 判断消息是否为 INIT 数据（含对 INIT_REQUEST 的响应）
  // 第三方回复 INIT_REQUEST 时 event 仍为 'INIT_REQUEST'，但会携带完整 INIT data
  function _isInitMessage(msg) {
    if (!msg || typeof msg !== 'object') return false
    var event = msg.event
    if (event === SDK_EVENTS.INIT || event === 'INIT') return true
    if (event === SDK_EVENTS.INIT_REQUEST || event === 'INIT_REQUEST') {
      // 排除我们自己发出去的空请求，只认来自 SDK 的响应
      return !!(msg.data && Object.keys(msg.data).length > 0 && msg.sender !== SDK_SENDER.WEBVIEW)
    }
    return false
  }

  function _fireInitReady() {
    if (_initReady) {
      return
    }
    _initReady = true
    window.__halopesaInitData = _initData
    var _userInfo = extractUserInfoFromInit(_initData || {})
    window.__halopesaUserInfo = _userInfo
    var cbs = _onInitReadyCallbacks.slice()
    _onInitReadyCallbacks = []
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](_initData) } catch(e) {}
    }
    try {
      window.dispatchEvent(new CustomEvent('halopesa:init-ready', { detail: _initData }))
    } catch(e) {}
  }

  // 尽早注册原生消息回调 + 主动等待 INIT（页面加载时即开始）
  ;(function _earlyInit() {
    // ★ Fix 1：无条件注册全部接收通道，不再因缺少 URL 参数 / 平台探测失败而完全不监听
    _registerUniversalReceiver()
    _bridgeRegistered = true

    // ★ 监听 HOST_APP_ON_ACTIVE — host app 回到前台时可能重新推送 INIT
    // 如果 INIT 尚未收到或数据为空，重置状态并重新等待
    eventBus.on('sdk:message', function (msg) {
      if (!msg) return
      if (msg.event === SDK_EVENTS.HOST_APP_ON_ACTIVE ||
          msg.event === 'HOST_APP_ON_ACTIVE' ||
          msg.event === SDK_EVENTS.IN_FOREGROUND) {
        if (!_initialized || !_initData || Object.keys(_initData).length === 0) {
          _initialized = false
          _initData = null
          sdkInit().then(function (data) {
            if (data && Object.keys(data).length > 0) {
              var info = extractUserInfoFromInit(data)
              if (info.linkToken && !_initReady) {
                _fireInitReady()
              }
            }
          }).catch(function () {})
        }
      }
    })

    // 立即尝试从 localStorage 恢复 INIT 数据（跨 reload + 跨 APP 退出重进）
    // 这样 halopesaLogin() 无需等待超时即可拿到 userInfo，有 linkToken 直接触发自动登录
    var cached = _loadInitFromStorage()
    if (cached && Object.keys(cached).length > 0) {
      _initData = cached
      _initialized = true
      var cachedInfo = extractUserInfoFromInit(cached)
      if (cachedInfo.linkToken) {
        _fireInitReady()
      }
      // ★ reload 后主动请求 fresh INIT（原生端不会自动推送，需主动请求；无渠道时静默跳过发送）
      requestInit()
      // 后台监听原生推送的新 INIT（可能带有刷新的 linkToken），收到后更新缓存
      var _freshInitUnsub = eventBus.on('sdk:message', function (msg) {
        if (!msg) return
        if (_isInitMessage(msg)) {
          var freshData = msg.data || msg
          _initData = freshData
          _initRequested = false
          _saveInitToStorage(freshData)
          var freshInfo = extractUserInfoFromInit(freshData)
          if (freshInfo.linkToken && !_initReady) {
            _fireInitReady()
          }
          _freshInitUnsub()
        }
      })
      return
    }

    // 无缓存，正常等待原生推送 INIT（最多等 30 秒；即使渠道未确认也保持被动监听）
    sdkInit().then(function (data) {
      var info = extractUserInfoFromInit(data || {})
      if (info.linkToken) {
        _fireInitReady()
      }
    }).catch(function () {})
  })()

  // 主动请求 INIT — miniapp 不确定何时能收到 INIT 时，可以主动发送 INIT_REQUEST
  // 原生端收到后会回复 INIT，无需被动等待。无渠道（getPlatform 为 null）时静默返回 false，不影响被动监听
  function requestInit() {
    var platform = getPlatform()
    if (!platform) return false
    if (!_receiverRegistered) { _registerUniversalReceiver() }
    var request = {
      event: SDK_EVENTS.INIT_REQUEST,
      sender: SDK_SENDER.WEBVIEW,
      request_id: genRequestId(),
      timestamp: Date.now(),
    }
    _initRequested = true
    return sendViaBridge(platform, request)
  }

  // sdkInit：
  //   - 始终确保接收器已注册（被动捕获 host 推送的 INIT），即使渠道未确认。
  //   - 已确认渠道则额外主动发 INIT_REQUEST。
  //   - 不再因"非 Halopesa 环境"直接 reject，避免丢掉 late/pushed INIT。
  function sdkInit() {
    if (_initialized) { return Promise.resolve(_initData) }
    var platform = getPlatform()

    // ★ Fix 1/2：无论渠道是否确认，都保证接收器已注册
    if (!_receiverRegistered) { _registerUniversalReceiver() }

    // ★ 已确认渠道 → 主动请求 INIT；未确认 → 仅被动等待 host 推送
    if (platform) { requestInit() }

    return new Promise(function (resolve, reject) {
      if (_initialized) { resolve(_initData); return }

      var resolved = false

      // 原生端会在 WebView 加载完成后自动推送 INIT，只需等待
      var timeout = setTimeout(function () {
        if (resolved) return
        // 超时回退：优先用 localStorage 中缓存的 INIT 数据（跨 reload + 退出重进恢复）
        var cached = _loadInitFromStorage()
        if (cached && Object.keys(cached).length > 0) {
          _initData = cached
          _initialized = true
          resolved = true
          resolve(_initData)
        } else {
          // 无缓存数据：不标记 _initialized，不取消监听
          // resolve 空对象让调用方不阻塞，但 _initialized 保持 false
          // 后续调用 sdkInit() 会重新等待；late INIT 到达后 listener 会更新状态
          resolved = true
          resolve({})
        }
      }, SDK_INIT_TIMEOUT_MS)

      var unsub = eventBus.on('sdk:message', function (msg) {
        if (_initialized) { unsub(); return }
        var isInit = _isInitMessage(msg)
        if (isInit) {
          clearTimeout(timeout)
          _initialized = true
          _initData = msg.data || msg
          _initRequested = false
          // 持久化到 localStorage，供下次 reload 或退出重进恢复
          _saveInitToStorage(_initData)
          if (!resolved) {
            resolved = true
            resolve(msg.data || msg)
          }
          unsub()
        }
      })
    })
  }

  function getInitData() { return _initData }
  function getDeviceInfo() { return _initData && _initData.internal ? _initData.internal.deviceInfo : null }
  function getBusinessInfo() { return _initData && _initData.external ? _initData.external : null }

  // 注册 INIT 就绪回调（收到 linkToken 后自动触发）
  // 用于实现"有 linkToken 就自动登录"的需求
  function onInitReady(fn) {
    if (typeof fn !== 'function') return
    if (_initReady) {
      try { fn(_initData) } catch(e) {}
    } else {
      _onInitReadyCallbacks.push(fn)
    }
  }
  function getUserPhone() { return _initData && _initData.external && _initData.external.generalInfo ? _initData.external.generalInfo.msisdn : null }

  function requestPermission(permission) {
    return sendToSdk(SDK_EVENTS.API_REQUEST, { permission: permission })
  }

  function requestPermissions(permissions) {
    return sendToSdk(SDK_EVENTS.API_REQUEST, { permissions: permissions })
  }

  function requestPayment(paymentData) {
    return sendToSdk(SDK_EVENTS.PAYMENT_REQUEST, paymentData)
  }

  function initPayment(requestToken) {
    return sendToSdk(SDK_EVENTS.INIT_PAYMENT, { requestToken: requestToken }, true)
  }


  function onPaymentResult(onSuccess, onFail) {
    var unsub1 = eventBus.on('sdk:message', function (msg) {
      if (!msg) return
      if (msg.sender === SDK_SENDER.WEBVIEW) return
      var event = msg.event
      var status = msg.data && msg.data.status
      if (event === SDK_EVENTS.NOTIFY_PAYMENT) {
        if (status === TRANSACTION_STATUS.SUCCESS || status === TRANSACTION_STATUS.PROCESSING || status === TRANSACTION_STATUS.PENDING_RECONCILIATION || status === TRANSACTION_STATUS.CONFIRMED) {
          if (onSuccess) onSuccess(msg.data)
        } else {
          if (onFail) onFail(msg.data)
        }
      }
    })
    return unsub1
  }

  function loginSuccess(authData, accountInfo) {
    return sendToSdk(SDK_EVENTS.LOGIN_SUCCESS, { auth: authData, accInfo: accountInfo })
  }

  function clearSession() { return sendToSdk(SDK_EVENTS.CLEAR_SESSION, null, true) }
  function sessionExpired() { return sendToSdk(SDK_EVENTS.EXPIRED_SESSION, null, true) }

  function exit(action, data) {
    return sendToSdk(SDK_EVENTS.EXIT, { response: data, navigationAction: action || 'STAY_CURRENT' }, true)
  }

  function openExternalLink(url) {
    return sendToSdk(SDK_EVENTS.OPEN_EXTERNAL_LINK, { uri: url }, true)
  }

  function openWebview(url, serviceName, returnUrl) {
    return sendToSdk(SDK_EVENTS.APP_OPEN_WEBVIEW, { url: url, serviceName: serviceName, returnUrl: returnUrl }, true)
  }

  function encryptData(body) { return sendToSdk(SDK_EVENTS.ENCRYPT_DATA, body).then(function (res) { return res.data }) }
  function decryptData(encrypted) { return sendToSdk(SDK_EVENTS.DECRYPT_DATA, { encrypted: encrypted }).then(function (res) { return res.data }) }

  function openPhoneCall(phoneNo) {
    return sendToSdk(SDK_EVENTS.OPEN_PHONE_CALL, phoneNo.replace(/\D/g, ''), true)
  }
  function writeToClipboard(str) { return sendToSdk(SDK_EVENTS.APP_WRITE_CLIPBOARD, str, true) }
  function requestLocationPermission() { return sendToSdk(SDK_EVENTS.REQUEST_LOCATION_PERMISSION, '') }
  function getLocation() { return sendToSdk(SDK_EVENTS.GET_LOCATION, '').then(function (res) { return res.data }) }
  function deviceConfig() { return sendToSdk(SDK_EVENTS.DEVICE_CONFIG, null, true) }

  function onSdkMessage(callback) { return eventBus.on('sdk:message', callback) }

  function cleanup() {
    if (_webMessageHandler) { window.removeEventListener('message', _webMessageHandler); _webMessageHandler = null }
    _initialized = false
    _initData = null
    try {
      localStorage.removeItem(INIT_STORAGE_KEY)
      localStorage.removeItem(HALOPESA_CONFIRMED_KEY)
    } catch(e) {}
  }

  // =====================================================================
  //  auth - 登录授权
  // =====================================================================

  // 获取缓存的 INIT 用户数据（页面加载时由 _earlyInit 自动接收并缓存）
  // 原生端通过 INIT 事件自动推送 phone/username，无需主动请求权限
  function halopesaLogin() {
    var platform = getPlatform()
    if (!platform) { return Promise.reject(new Error('Not running in the Halopesa App environment: cannot login')) }
    if (!_receiverRegistered) { _registerUniversalReceiver() }

    // INIT 数据已由 _earlyInit 在页面加载时自动接收并缓存
    // 此处直接读取缓存；若尚未收到 INIT，则等待一次
    if (_initialized && _initData && Object.keys(_initData).length > 0) {
      return Promise.resolve(extractUserInfoFromInit(_initData))
    }

    // _initialized=true 但 _initData 为空（不应该发生了，Fix 1 后超时不再设 _initialized=true）
    // 但保留安全网
    if (_initialized && (!_initData || Object.keys(_initData).length === 0)) {
      _initialized = false
      _initData = null
    }

    // ★ URL params fallback：如果 INIT 尚未收到，但 host app 已通过 URL 传递 phoneNumber
    // phoneNumber 是登录必须的字段，有它就能登录（linkToken 有无决定自动/手动登录）
    if (!_initialized) {
      var urlInfo = _extractFromUrlParams()
      if (urlInfo.phoneNumber) {
        // 后台继续等待 INIT 以补充更完整的数据（如 linkToken/username）
        sdkInit().then(function (data) {
          if (data && Object.keys(data).length > 0) {
            var info = extractUserInfoFromInit(data)
            if (info.linkToken && !_initReady) {
              _fireInitReady()
            }
          }
        }).catch(function () {})
        // 立即返回 URL 中的数据
        return Promise.resolve(urlInfo)
      }
    }

    // INIT 尚未收到且 URL 无 phoneNumber，等待原生推送
    return sdkInit().then(function (initData) {
      initData = initData || {}
      return extractUserInfoFromInit(initData)
    })
  }

  // 从 URL query params 提取用户信息（host app 可能已通过 URL 传递 linkToken 等）
  function _extractFromUrlParams() {
    var result = { phoneNumber: '', linkToken: '', username: '' }
    try {
      var params = new URLSearchParams(window.location.search)
      result.linkToken = params.get('linkToken') || params.get('link_token') || params.get('linktoken') || ''
      result.phoneNumber = params.get('msisdn') || params.get('phoneNumber') || params.get('phone_number') || params.get('phone') || ''
      result.username = params.get('username') || params.get('userName') || params.get('user_name') || ''
    } catch(e) {}
    return result
  }

  // 从 INIT data 直接提取用户信息（原生端通过 INIT 事件自动推送）
  function extractUserInfoFromInit(initData) {
    initData = initData || {}
    var ext = initData.external || {}
    var intData = initData.internal || {}
    var generalInfo = ext.generalInfo || {}
    var deviceInfo = intData.deviceInfo || {}
    // 解析 extraData（JSON 字符串，内包含 msisdn/linkToken 等）
    var extraData = {}
    if (typeof generalInfo.extraData === 'string') {
      try { extraData = JSON.parse(generalInfo.extraData) } catch(e) {}
    } else if (generalInfo.extraData) {
      extraData = generalInfo.extraData
    }
    // 手机号：extraData.msisdn > generalInfo.msisdn > 顶层字段 > URL query params
    var phone = extraData.msisdn || generalInfo.msisdn
              || initData.phoneNumber || initData.phone_number || initData.phone || ''
    // linkToken：来自 extraData > URL query params（host app 可能已通过 URL 传递）
    var linkToken = extraData.linkToken || ''
    // 用户名：extraData > generalInfo > 顶层字段 > URL query params
    var username = extraData.username || extraData.userName || extraData.user_name
                || generalInfo.username || generalInfo.userName || initData.username
                || initData.userName || initData.user_name || initData.name || ''
    // URL query params fallback（host app 通过 URL 传递 linkToken/phone 等）
    if (!linkToken || !phone || !username) {
      var urlInfo = _extractFromUrlParams()
      if (!linkToken) { linkToken = urlInfo.linkToken }
      if (!phone) { phone = urlInfo.phoneNumber }
      if (!username) { username = urlInfo.username }
    }
    return {
      phoneNumber: phone,
      username:    username,
      fullName:    initData.fullName || initData.full_name || username || '',
      avatarUrl:   initData.avatarUrl || initData.avatar_url || '',
      imei:        initData.imei || (deviceInfo.imei || ''),
      os:          initData.os || ((deviceInfo.platform && deviceInfo.platform.os) || ''),
      osVersion:   initData.osVersion || ((deviceInfo.platform && deviceInfo.platform.osVersion) || ''),
      masterMerchantCode: initData.masterMerchantCode || generalInfo.masterMerchantCode || '',
      merchantCode: initData.merchantCode || generalInfo.merchantCode || '',
      linkToken:   linkToken,
      raw: initData,
    }
  }

  function submitUserInfoToBackend(userInfo, apiCall) {
    if (typeof apiCall !== 'function') { throw new Error('apiCall must be a function') }
    return apiCall({
      phoneNumber: userInfo.phoneNumber,
      username: userInfo.username,
      fullName: userInfo.fullName,
      imei: userInfo.imei,
      os: userInfo.os,
      linkToken: userInfo.linkToken,
      merchantCode: userInfo.merchantCode,
    })
  }

  // 完整登录流程：获取 INIT 用户数据 → 提交后端 → 返回结果
  // backendLoginApi: 接收 userInfo，调用后端登录接口，返回后端响应
  function fullLoginFlow(backendLoginApi) {
    return halopesaLogin().then(function (userInfo) {
      if (!userInfo.phoneNumber) { throw new Error('Failed to retrieve phone number: please make sure the permission is granted') }
      return submitUserInfoToBackend(userInfo, backendLoginApi).then(function (backendResult) {
        // 通知 SDK 登录成功（仅通知，不影响返回值）
        if (backendResult && (backendResult.auth || backendResult.token)) {
          loginSuccess(
            backendResult.auth || { token: backendResult.token },
            backendResult.accInfo || {}
          ).catch(function (e) {})
        }
        // 始终把完整的 userInfo + backendResult 返回给调用方
        return { userInfo: userInfo, backendResult: backendResult }
      })
    })
  }

  // =====================================================================
  //  payment - 支付流程
  // =====================================================================

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  function notifyStatus(callback, status) { if (typeof callback === 'function') callback(status) }

  function startPayment(options) {
    options = options || {}
    var createOrderApi = options.createOrderApi
    var orderData = options.orderData || {}
    var onStatusChange = options.onStatusChange
    var inquiryApi = options.inquiryApi

    if (typeof createOrderApi !== 'function') { throw new Error('createOrderApi must be a function') }

    notifyStatus(onStatusChange, 'INITIALIZING')
    return createOrderApi(orderData).then(function (orderResult) {
      var orderId = orderResult.orderId || (orderResult.data && orderResult.data.orderId)
      var requestToken = orderResult.requestToken || (orderResult.data && orderResult.data.requestToken)
      if (!requestToken) { throw new Error('Failed to retrieve requestToken: please check the backend API') }

      notifyStatus(onStatusChange, TRANSACTION_STATUS.PROCESSING)
      return initPayment(requestToken).then(function () {
        return waitForPaymentResult({ orderId: orderId, requestToken: requestToken, onStatusChange: onStatusChange, inquiryApi: inquiryApi })
      }).catch(function (e) {
        notifyStatus(onStatusChange, TRANSACTION_STATUS.FAILED)
        throw e
      })
    })
  }

  function startPaymentWithData(paymentData, options) {
    options = options || {}
    var onStatusChange = options.onStatusChange
    var inquiryApi = options.inquiryApi

    notifyStatus(onStatusChange, TRANSACTION_STATUS.PROCESSING)
    return requestPayment(paymentData).then(function () {
      return waitForPaymentResult({ onStatusChange: onStatusChange, inquiryApi: inquiryApi })
    }).catch(function (e) {
      notifyStatus(onStatusChange, TRANSACTION_STATUS.FAILED)
      throw e
    })
  }

  function waitForPaymentResult(options) {
    options = options || {}
    var orderId = options.orderId
    var requestToken = options.requestToken
    var onStatusChange = options.onStatusChange
    var inquiryApi = options.inquiryApi

    return new Promise(function (resolve, reject) {
      var unsub = onPaymentResult(
        function (data) {
          unsub()
          handlePaymentResult('SUCCESS', data, { orderId: orderId, requestToken: requestToken, onStatusChange: onStatusChange, inquiryApi: inquiryApi })
            .then(resolve)
            .catch(reject)
        },
        function (data) {
          unsub()
          handlePaymentResult('FAILED', data, { orderId: orderId, requestToken: requestToken, onStatusChange: onStatusChange, inquiryApi: inquiryApi })
            .then(resolve)
            .catch(reject)
        }
      )
      setTimeout(function () {
        unsub()
        notifyStatus(onStatusChange, TRANSACTION_STATUS.PENDING_RECONCILIATION)
        resolve({ status: TRANSACTION_STATUS.PENDING_RECONCILIATION, orderId: orderId, requestToken: requestToken })
      }, 100000)
    })
  }

  function handlePaymentResult(sdkStatus, sdkData, opts) {
    var orderId = opts.orderId
    var requestToken = opts.requestToken
    var onStatusChange = opts.onStatusChange
    var inquiryApi = opts.inquiryApi

    if (typeof inquiryApi === 'function') {
      notifyStatus(onStatusChange, TRANSACTION_STATUS.PROCESSING)
      return pollInquiry(orderId, inquiryApi, onStatusChange).then(function (finalStatus) {
        notifyStatus(onStatusChange, finalStatus)
        return { status: finalStatus, orderId: orderId, requestToken: requestToken, sdkStatus: sdkStatus, sdkData: sdkData }
      }).catch(function (err) {
        var fallback = sdkStatus === 'SUCCESS' ? TRANSACTION_STATUS.SUCCESS : TRANSACTION_STATUS.FAILED
        notifyStatus(onStatusChange, fallback)
        return { status: fallback, orderId: orderId, requestToken: requestToken, sdkStatus: sdkStatus, sdkData: sdkData }
      })
    }
    var status = sdkStatus === 'SUCCESS' ? TRANSACTION_STATUS.SUCCESS : TRANSACTION_STATUS.FAILED
    notifyStatus(onStatusChange, status)
    return Promise.resolve({ status: status, orderId: orderId, requestToken: requestToken, sdkStatus: sdkStatus, sdkData: sdkData })
  }

  function pollInquiry(orderId, inquiryApi, onStatusChange) {
    var finalStates = [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED]
    var chain = Promise.resolve()
    INQUIRY_RETRY_POLICY.forEach(function (policy) {
      chain = chain.then(function (prevStatus) {
        if (prevStatus && finalStates.indexOf(prevStatus) !== -1) return prevStatus
        if (policy.delay > 0) return sleep(policy.delay).then(function () { return tryInquiry(orderId, inquiryApi, onStatusChange, policy.attempt) })
        return tryInquiry(orderId, inquiryApi, onStatusChange, policy.attempt)
      })
    })
    return chain.then(function (status) { return status || TRANSACTION_STATUS.PENDING_RECONCILIATION })
  }

  function tryInquiry(orderId, inquiryApi, onStatusChange, attempt) {
    var finalStates = [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED]
    return inquiryApi(orderId).then(function (result) {
      var status = result && result.status ? result.status : (result && result.data ? result.data.status : null)
      if (status && finalStates.indexOf(status) !== -1) return status
      notifyStatus(onStatusChange, TRANSACTION_STATUS.PROCESSING)
      return null
    }).catch(function (err) {
      return null
    })
  }

  function getPaymentStatusUI(status) {
    var map = {}
    map[TRANSACTION_STATUS.SUCCESS] = { text: 'Payment completed successfully', type: 'success' }
    map[TRANSACTION_STATUS.FAILED] = { text: 'Payment failed', type: 'error' }
    map[TRANSACTION_STATUS.PROCESSING] = { text: 'Processing transaction...', type: 'loading' }
    map[TRANSACTION_STATUS.PENDING_RECONCILIATION] = { text: 'Transaction processing in background', type: 'warning' }
    map[TRANSACTION_STATUS.CANCELLED] = { text: 'Payment cancelled', type: 'info' }
    map['INITIALIZING'] = { text: 'Initializing payment...', type: 'loading' }
    return map[status] || { text: status, type: 'info' }
  }

  // =====================================================================
  //  ipn - 支付回调处理
  // =====================================================================

  function handlePaymentNotify(notifyData, inquiryApi, onResult) {
    var orderId = notifyData && (notifyData.orderId || notifyData.order_id)
    if (!orderId) { return }
    if (typeof inquiryApi !== 'function') {
      if (typeof onResult === 'function') { onResult({ status: notifyData && notifyData.status, orderId: orderId, raw: notifyData }) }
      return
    }
    return pollInquiry(orderId, inquiryApi).then(function (finalStatus) {
      var result = { status: finalStatus, orderId: orderId, raw: notifyData }
      if (typeof onResult === 'function') onResult(result)
      return result
    }).catch(function (err) { throw err })
  }

  function isPaymentSuccess(status) { return status === TRANSACTION_STATUS.SUCCESS }
  function isPaymentFailed(status) { return status === TRANSACTION_STATUS.FAILED || status === TRANSACTION_STATUS.CANCELLED }
  function isPendingReconciliation(status) { return status === TRANSACTION_STATUS.PENDING_RECONCILIATION }

  // =====================================================================
  //  暴露全局 API
  // =====================================================================

  var HalopesaSDK = {
    // 版本
    VERSION: '1.0.0',

    // 常量
    SDK_PLATFORM: SDK_PLATFORM,
    SDK_SENDER: SDK_SENDER,
    SDK_EVENT_CODES: SDK_EVENT_CODES,
    SDK_EVENTS: SDK_EVENTS,
    EXIT_ACTIONS: EXIT_ACTIONS,
    SDK_PERMISSIONS: SDK_PERMISSIONS,
    API_PATHS: API_PATHS,
    TRANSACTION_STATUS: TRANSACTION_STATUS,
    INQUIRY_RETRY_POLICY: INQUIRY_RETRY_POLICY,

    // 环境检测
    detectPlatform: detectPlatform,
    isHalopesaApp: isHalopesaApp,
    isNativeApp: isNativeApp,

    // SDK 初始化
    sdkInit: sdkInit,
    requestInit: requestInit,
    getInitData: getInitData,
    getDeviceInfo: getDeviceInfo,
    getBusinessInfo: getBusinessInfo,
    getUserPhone: getUserPhone,

    // 权限
    requestPermission: requestPermission,
    requestPermissions: requestPermissions,

    // 底层通信
    sendToSdk: sendToSdk,
    onSdkMessage: onSdkMessage,

    // 会话管理
    loginSuccess: loginSuccess,
    clearSession: clearSession,
    sessionExpired: sessionExpired,

    // 导航/退出
    exit: exit,
    openExternalLink: openExternalLink,
    openWebview: openWebview,

    // 加密
    encryptData: encryptData,
    decryptData: decryptData,

    // 其他
    openPhoneCall: openPhoneCall,
    writeToClipboard: writeToClipboard,
    requestLocationPermission: requestLocationPermission,
    getLocation: getLocation,
    deviceConfig: deviceConfig,

    // 清理
    cleanup: cleanup,

    // 登录授权
    halopesaLogin: halopesaLogin,
    extractUserInfo: extractUserInfoFromInit,
    submitUserInfoToBackend: submitUserInfoToBackend,
    fullLoginFlow: fullLoginFlow,
    onInitReady: onInitReady,

    // 支付
    initPayment: initPayment,
    requestPayment: requestPayment,
    onPaymentResult: onPaymentResult,
    startPayment: startPayment,
    startPaymentWithData: startPaymentWithData,
    waitForPaymentResult: waitForPaymentResult,
    pollInquiry: pollInquiry,

    // 诊断

    getPaymentStatusUI: getPaymentStatusUI,

    // IPN
    handlePaymentNotify: handlePaymentNotify,
    isPaymentSuccess: isPaymentSuccess,
    isPaymentFailed: isPaymentFailed,
    isPendingReconciliation: isPendingReconciliation,
  }

  // CommonJS / AMD / 全局
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = HalopesaSDK
  } else if (typeof define === 'function' && define.amd) {
    define([], function () { return HalopesaSDK })
  } else {
    global.HalopesaSDK = HalopesaSDK
  }

})(typeof window !== 'undefined' ? window : this)

var _GTAG_ID = "G-Z48ZZR7C49";
var _COUNTRY = {
    "0": "ke",
    "1": "ug",
    "2": "ng",
    "4": "gh",
    "5": "tz"
};

var _FACEBOOK_CHANNEL = {
    SWVVFBBET:'1339817950218888',
    SWZYFB:'957895621990242',
    CWVVFBT:'896271524983664',
    CWVVFBY:'304385262000864',
    CWVVFBAB:'304385262000864',
    CWVVFBWI: '304385262000864',
    CWVVFBABWI:'304385262000864',
    CWVVFBDLHUNT:'918309925973067',
    CWVVFBGAT: '581867573797335',
    SWVVFBGATHER:'751363942822513',
    SWFBLXH5: '1465122380775399',
    SWFBDYH:'1353450592394998',
    KSWFBDL:'1312543243724429',
    SWBDPWAEXTKE: '871605411902952',
    SWBDPWAGH: '1892182091723291',
    SWBDPWANG: '877502854937776',
    SWBDPWATZ: '877502854937776',
    SWBDPWAKE: '1254661030040455',
    KSWBDPWAEXTKE: '832015742889915',
    USWBDPWAEXTKE: '1754760535882198',
    UCWVVFBGAME: '1754760535882198'
};

const _FIREBASE = {
    "SWGGLXH5": "1",
    "SWGGZYH5": "1",
    "CWVVGGGAME": "1",
    "CWVVGGSPORTS": "1",
    // google 投放渠道标记：命中后初始化 Firebase 并上报 first_open
    "WVVGG": "1",
    "GOOGLE": "1",
}

function isPwa() {
    var isPwa = false;
    try {
        isPwa = window.navigator.standalone || (window.matchMedia('(display-mode: standalone)').matches);
    } catch (err) {
        console.log(err);
    }
    return isPwa;
}
function getLocalStorage(key) {
    var rlt = null;
    window.localStorage && (rlt = window.localStorage.getItem(key));
    return rlt;
}

function removeLocalStorage(key) {
    window.localStorage && window.localStorage.removeItem(key);
}

function setLocalStorage(key, value) {
    window.localStorage && window.localStorage.setItem(key, value);
}

function isNewPlayer() {
    var nowDate = new Date();
    var nowFullDate = nowDate.getFullYear() + "_" + nowDate.getMonth();
    var accessDate = getLocalStorage("access-date");
    if (accessDate) {
        nowFullDate += "_" + nowDate.getDate();
        if (nowFullDate != accessDate) {
            return false;
        } else {
            return true;
        }
    } else {
        //old mode check used user
        var channelFlag = getLocalStorage("channel");
        var isNewPlayer = !channelFlag;
        if (isNewPlayer) {
            nowFullDate += "_" + nowDate.getDate();
        } else {
            nowFullDate += "_" + (nowDate.getDate() - 1);
        }
        setLocalStorage("access-date", nowFullDate);
        return isNewPlayer;
    }
}

function trimSpace(str) {
    if (!str) {
        return "";
    }
    str = str.replace(/^\s*|\s*$/g, "");
    if (str == "null" || str == "undefined") {
        return "";
    }
    return str;
}

/**
 * uri params
 */
function analyzeUrl() {
    var baseUri = window.location.search;
    var hrefArr = baseUri.split("?");
    var query = hrefArr.length > 1 ? hrefArr[1] : "";
    var vars = query.split("&");
    // cnQuery: { } // google advertising parameters
    var rlt = {

    };
    for (var i = 0; i < vars.length; i++) {
        if (trimSpace(vars[i]) == "") continue;
        var pair = vars[i].split("=");
        var pairKey = trimSpace(pair[0]);
        var pairVal = trimSpace(pair[1]);
        if (pair.length < 2) {
            !rlt['cn'] && (rlt['cn'] = pairKey);
        } else {
            var utmArr = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term'];
            if (!rlt['cn'] && pairKey.toLowerCase() == 'utm_term') {
                rlt['cn'] = pairVal;
                !rlt.cnQuery && (rlt.cnQuery = {});
                rlt.cnQuery['utm_term'] = pairVal;
            } else {
                if (utmArr.indexOf(pairKey.toLowerCase()) != -1) {
                    !rlt.cnQuery && (rlt.cnQuery = {});
                    rlt.cnQuery[pairKey] = pairVal;
                } else {
                    rlt[pairKey] = pairVal;
                }
            }
        }
    }
    if (rlt['cn'] && !rlt['country']) {
        var c = rlt['cn'].substring(0, 1).toLowerCase();
        if (c == "u") rlt['country'] = "ug";
        else if (c == "k") rlt['country'] = "ke";
        else if (c == "n") rlt['country'] = "ng";
        else if (c == "g") rlt['country'] = "gh";
        else if (c == "g") rlt['country'] = "tz";
        else rlt['country'] = "ke";
    }
    // if (rlt['country'] && !rlt['cn']) {
    //     if (rlt['country'] == "ke") rlt['cn'] = "KSWVVSYS";
    //     else if (rlt['country'] == "ug") rlt['cn'] = "USWVVSYS";
    //     else if (rlt['country'] == "ng") rlt['cn'] = "NSWVVSYS";
    //     else if (rlt['country'] == "gh") rlt['cn'] = "GSWVVSYS";
    //     else rlt['cn'] = "KSWVVSYS";
    // }
    if (rlt['koc']) {
        rlt['cn'] = rlt['koc'];
    }
    return rlt;
}

function loadJs(url, callback) {
    var script = document.createElement('script');
    script.type = "text/javascript";
    if (typeof (callback) != "function") return;
    if (script.readyState) {
        script.onreadystatechange = function () {
            if (script.readyState == "loaded" || script.readyState == "complete") {
                script.onreadystatechange = null;
                callback();
            }
        }
    } else {
        script.onload = function () {
            callback();
        }
    }
    script.src = url;
    document.body.appendChild(script);
}

//------------------------- third part jssdk ----
function checkChannel(arr) {
    if (!window.bangGoogle) return null;
    if (!window.bangGoogle.channel) return null;
    // it's not all channel
    var channel = window.bangGoogle.channel.toUpperCase();
    var _fbId = arr[channel];
    if (!_fbId && channel) {
        for (var key in arr) {
            if (channel.indexOf(key.toUpperCase()) != -1) {
                _fbId = arr[key];
            }
        }
    }
    return _fbId;
}

//------------------------- google 投放渠道上报 -------------------------
// 仅 WVVGG / google 两个渠道标记需要做 Firebase 初始化上报
const _GOOGLE_AD_CHANNELS = ['WVVGG', 'GOOGLE'];

function isGoogleAdChannel (channel) {
    if (!channel) return false;
    var cn = String(channel).toUpperCase();
    for (var i = 0; i < _GOOGLE_AD_CHANNELS.length; i++) {
        if (cn.indexOf(_GOOGLE_AD_CHANNELS[i]) != -1) return true;
    }
    return false;
}

// 从 _ga / _ga_XXXX cookie 解析 GA client_id
// （本项目 Firebase 用 compat 版 CDN 引入，没有 modular 的 getGoogleAnalyticsClientId）
function getGaClientId () {
    try {
        var cookies = document.cookie ? document.cookie.split(';') : [];
        for (var i = 0; i < cookies.length; i++) {
            var item = cookies[i].replace(/^\s+|\s+$/g, '');
            var idx = item.indexOf('=');
            if (idx < 0) continue;
            var name = item.substring(0, idx);
            var value = item.substring(idx + 1);
            if (name.indexOf('_ga') !== 0) continue;
            // 格式：GA1.1.<clientId>.<timestamp>
            var parts = value.split('.');
            if (parts.length >= 4 && parts[0].indexOf('GA') === 0) {
                var cid = parts[2] + '.' + parts[3];
                return cid;
            }
        }
    } catch (err) {
        console.log('getGaClientId error', err);
    }
    return '';
}

// 供 Vue 侧（如 make_purchase 上报）读取当前 client_id
window.getFirebaseClientId = function () {
    return getLocalStorage('Fid') || getGaClientId();
};

// 需求3：client_id 变化后上报给后端
// POST {base}/api/center/firebase/update ，body: { clientId }
// base 由 Vue 侧注入（main.js: window.firebaseApiBase = httpBaseConfig.gamingUrl）
function reportClientIdToServer (clientId, oldClientId, channel) {
    if (!clientId) return;
    var base = window.firebaseApiBase || '';
    if (!base) {
                return;
    }
    try {
        var url = base + '/api/center/firebase/update';
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                            }
        };
        xhr.send(JSON.stringify({ clientId: clientId }));
            } catch (err) {
            }
}

function watchClientIdChange (clientId, channel) {
    if (!clientId) {
                return;
    }
    var oldClientId = getLocalStorage('Fid');
    setLocalStorage('Fid', clientId);
        if (oldClientId !== clientId) {
        reportClientIdToServer(clientId, oldClientId, channel);
    }
}

// 事件A：进入主站、Firebase 初始化完成时上报 first_open
// client_id 无变化则只上报一次，后续不再上报
function reportFirstOpen (clientId, channel) {
    var lastCid = getLocalStorage('firebase-first-open-cid');
    if (clientId) {
        if (lastCid === clientId) {
                        return;      // 同一 client_id 已上报过
        }
    } else {
        if (lastCid === 'reported') {
                        return;    // 取不到 client_id 时按已上报去重
        }
    }
    setLocalStorage('firebase-first-open-cid', clientId || 'reported');
    var params = {
        client_id: clientId,
        timestamp: (new Date()).getTime(),
        page_source: document.referrer || '',
        page_url: window.location.href
    };
        window.firebaseEvent('first_open', params);
}

// client_id 由 SDK 异步写入 cookie，做有限次重试
function tryGetClientId (attempt, callback) {
    var clientId = getGaClientId();
    if (clientId || attempt >= 5) {
        callback(clientId);
        return;
    }
    setTimeout(function () {
        tryGetClientId(attempt + 1, callback);
    }, 300);
}

// Firebase 初始化完成回调
// channel 由 initFirebase 在初始化时快照传入：SDK 异步加载期间
// window.bangGoogle.channel 可能被页面后续逻辑改写，不能在回调时重新读取
function onFirebaseInited (channel) {
    channel = channel || '';
        if (!isGoogleAdChannel(channel)) return;
    tryGetClientId(0, function (clientId) {
        watchClientIdChange(clientId, channel);   // 需求3：变化监控
        reportFirstOpen(clientId, channel);       // 事件A：first_open
    });
}

function initFirebase () {
        if (window.bangGoogle.channelCode) {
                return;
    }
    var _firebaseId = checkChannel(_FIREBASE);
        if (!!_firebaseId) {
        var firebaseConfig = {
            apiKey: "AIzaSyCHOCOq22UMybiDzOfR-ybOkNLFKjOMOhs",
            authDomain: "xlotbet-20399.firebaseapp.com",
            databaseURL: "https://xlotbet-20399.firebaseio.com",
            projectId: "xlotbet-20399",
            storageBucket: "xlotbet-20399.appspot.com",
            messagingSenderId: "565089040122",
            appId: "1:565089040122:web:39ed8ae006fb285abefb43",
            measurementId: "G-7G4GNWQ02M"
        };
        // 快照初始化时的渠道，供 SDK 加载完成回调使用
        var _initChannel = (window.bangGoogle && window.bangGoogle.channel) || '';
                loadJs('https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js', function () {
            loadJs('https://www.gstatic.com/firebasejs/10.4.0/firebase-analytics-compat.js', function () {
                firebase.initializeApp(firebaseConfig);
                onFirebaseInited(_initChannel);
            })
        })
    }
}

// 初始化Facebook pixel
function initFacebook () {
    if (!window.bangGoogle.channel) {
      return;
    }
    var pixelId = checkChannel(_FACEBOOK_CHANNEL);

    if (!!pixelId) {
      !function(f,b,e,v,n,t,s) {
        if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)
      }(window, document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', pixelId);
      fbq('track', 'PageView');
    }
}





//--------------------window funciton------------------------------------
window.initBang = function () {
    if (!window.bangGoogle) return;
    var country = getLocalStorage("country");
    if (country) {
        _COUNTRY[country] && (window.bangGoogle['country'] = _COUNTRY[country]);
    }
    var channel = getLocalStorage("channel");
    channel && (channel = JSON.parse(channel));
    channel && (window.bangGoogle['channel'] = channel, window.cachechannel = channel);
}

//--google path
window.renderPage = function () {
    var path = window.location.pathname;
    (path == "/") && (path = "/index");
    path += "/render";
    if (window.lastRenderPath != path) {
        window.lastRenderPath = path;
        if (window.bangGoogle) {
            if (window.bangGoogle.country) path += "/" + window.bangGoogle.country; else path += "/unkown";
            if (window.bangGoogle.isNewPlayer) path += "/new"; else path += "/old";
            if (window.bangGoogle.isPwa) path += "/pwa"; else path += "/h5";
            if (window.bangGoogle.channel) path += "/" + window.bangGoogle.channel; else path += "/unkown";
        }
        gtag("event", "page_view", { 'page_path': path });
    }
}

window.getIosIdfa=(idfa,adid)=>{
    if(localStorage){
        localStorage.setItem('IosAdid', adid)
        localStorage.setItem('IosIdfa', idfa)
    }
}

window.initialization = function () {
    if (window.localStorage.getItem('page_only') == 2) {
        window.googleEvent && window.googleEvent("", "page_only", 0);
        window.localStorage.setItem('page_only', 1);
    }
}

//-----------google event------
window.googleUserData = function(){
    var dataStr = getLocalStorage("user");
    if (!!dataStr) {
        try {
            var data = JSON.parse(dataStr);
            if (data.username) {
                //has been setted.
                if (window.googleUserPhone && window.googleUserPhone == data.username) {
                    return;
                }
                gtag('set', 'user_data', {
                    'phone_number': "+"+data.username
                });
                window.googleUserPhone = data.username;
                //report register info
                var regTag = getLocalStorage("isgoogleRegister");
                if (!!regTag && regTag == "1") {
                    var channel = data.channel;
                    if (!channel) channel = "UNKOWN";
                    gtag('event', 'complete_register', {
                        'event_category': "register",
                        'event_label': channel
                    });
                    removeLocalStorage("isgoogleRegister");
                }
            }
        } catch(e){

        }
    }
}

window.googleEvent = function (category, action, value, params) {
    //close the event action
    if (window.bangGoogle) {
        !window.bangGoogle.timerEvents && (window.bangGoogle.timerEvents = {});
        if (window.bangGoogle.country) category += "_" + window.bangGoogle.country; else category += "_unkown";
        if (window.bangGoogle.isNewPlayer) action += "_new"; else action += "_old";
        if (window.bangGoogle.isPwa) action += "_pwa"; else action += "_h5";
        if (category == "initialization" && action == "socket") {
            if (window.isNeedInitSocket) {
                window.isNeedInitSocket = false;
                value = "time";
            } else {
                category = "apiSpeed";
            }
        }
        // special events
        // init event and time event must be the same about number.
        // it's a pair events.
        var timeKey = null;
        if (category == "apiSpeed") {
            if (action.indexOf("rollMatch") != -1) {
                timeKey = "apiSpeed-rollMatch";
            }
        }
        if (value == "init") {
            window.bangGoogle.time = (new Date()).getTime();
            value = 0;
            if (timeKey) {
                if (window.bangGoogle.timerEvents[timeKey]) {
                    var gap = window.bangGoogle.time - window.bangGoogle.timerEvents[timeKey];
                    // max expire time = 10sec
                    if (gap < 10000) {
                        return;
                    }
                }
                window.bangGoogle.timerEvents[timeKey] = window.bangGoogle.time;
            }
        } else if (value == "time") {
            var now = (new Date()).getTime();
            !window.bangGoogle.time && (window.bangGoogle.time = now);
            value = now - window.bangGoogle.time;
            if (timeKey && window.bangGoogle.timerEvents[timeKey]) {
                window.bangGoogle.timerEvents[timeKey] = 0;
                delete window.bangGoogle.timerEvents[timeKey];
            }
        }
    }
    !value && (value = 0);
    isNaN(parseFloat(value)) && (value = 0);
    value = parseInt(value);
    gtag('event', action, {
        'event_category': category,
        'event_label': getPlatfromChannel(),
        'value': value,
        'event_referrer': document.referrer,
        'event_device': window.bangGoogle.isPwa ? "pwa" : "h5",
        ...(params || {})
    });
}



window.googleAdEvent = function (action, value) {
    const channels = ['WGG3479', 'WVVGG3479']
    // 过滤渠道标
    const flag = channels.some(item => window.bangGoogle && window.bangGoogle.channel.includes(item))
    if (flag) {
        let currency = ''
        const currencyOpt = {
            ke: 'KES',
            gh: 'GHS',
            tz: 'TZS',
            ng: 'NGN',
            ur: 'UGX',
        }

        if (window.bangGoogle && window.bangGoogle.country) {
            currency = currencyOpt[window.bangGoogle.country]
        }

        gtag('event', 'conversion', {
            'send_to': 'AW-11285167297/' + action,
            'value': value,
            'currency': currency
        })
    }
}

// 根据设备展示不同渠道标
function getPlatfromChannel() {
  let channel = window.bangGoogle.channel || "default";
  if (window.bangGoogle.isPwa) {
    let urls = ['keopen.hoteasymoney777.com', 'pwagame123.com', 'jamesbang3.com', 'housex6cookie.com', 'happy7dday.com', 'bedroom3w.com']
    let referrer = document.referrer;
    if (!channel.includes("SWBDPWA")) {
      let country = window.bangGoogle.country.toUpperCase();
      urls.forEach((url, index) => {
        if (referrer.includes(url)) {
          channel = index == 0 ? country + 'SWBDPWA777HY' : country + 'SWBDPWA123HY';
        }
      });

    }
  }

  return channel;
}

//------------------------auto action------------------------------------
function init() {
    window.googleUserData && window.googleUserData();
    window.bangGoogle = {
        country: "ke",
        channel: "KSWVVSYS",
        isNewPlayer: isNewPlayer(),
        isPwa: isPwa(),
        time: (new Date()).getTime()
    }
    window.cachechannel = "";
    window.urlChannel = "";
    var params = analyzeUrl();

    params['country'] && (window.bangGoogle['country'] = params['country']);
    window.initBang();
    //before show platform: uri , cache
    //after show platfrom: cache
    params['cn'] && (window.bangGoogle['channel'] = params['cn'], window.urlChannel = params['cn'], setLocalStorage("channel", JSON.stringify(params['cn'])));
        // 入口级日志：只要 google.js 是新副本且被执行，这条必然出现
    //jqueryfo
    params.cnQuery && (setLocalStorage("init.string", JSON.stringify(params.cnQuery)), setLocalStorage("init.objStr", JSON.stringify(params.cnQuery)));
    // invitation_code
    params.koc && (setLocalStorage("invitation_code", params.koc));
    //google upload
    window.initialization() && window.initialization();
    //socket event tag
    window.isNeedInitSocket = true;
}

function setPerfume() {
    var metricNames = ['fp', 'fcp', 'lcp', 'lcpFinal', 'fid', 'cls', 'clsFinal', 'tbt', 'tbt10S', 'tbtFinal', 'homeRollBall'];
    new Perfume({
        analyticsTracker: function (res) {
            //{metricName, data, navigatorInformation}
            var metricName = res.metricName;
            var data = res.data;
            var navigatorInformation = res.navigatorInformation;
            // if (metricNames && metricNames.indexOf(metricName) != -1) {
            //     gtag('event', metricName, {
            //         'event_category': 'Performance.mobile',
            //         'value': metricName === 'cls' ? data * 1000 : data,
            //         'event_label': navigatorInformation.isLowEndExperience ? 'lowEndExperience' : 'highEndExperience'
            //     });
            // }
            try {
                if (metricName == 'resourceTiming') {
                    // if (data.initiatorType == 'xmlhttprequest') {
                    //     if (apiSpeedObj && location.pathname == '/m/') {
                    //         var key = data.name
                    //         if (key.indexOf('casino-api') != -1 || key.indexOf('bet-api') != -1) {
                    //             if (apiSpeedObj[key] && typeof apiSpeedObj[key] == 'object') {
                    //                 apiSpeedObj[key].push(data.duration)
                    //             } else {
                    //                 apiSpeedObj[key] = [data.duration]
                    //             }
                    //         }
                    //     }
                    // }
                    if (data.initiatorType == 'script' && location.pathname == '/m/') {
                        gtag('event', data.name, {
                            'event_category': 'home_js_start_time',
                            'value': data.startTime
                        });
                    }
                }
            } catch (err) {
                console.log('perfume analyze error', e);
            }
        }
    });
}

function setListener() {
    window.addEventListener('pageLoaded', function () {
        var ele = document.getElementById('bet-insert')
        var timeStamp = localStorage.getItem('time-stamp')
        var time = new Date().getTime()
        var gap = 0
        if (ele) {
            if (timeStamp) {
                gap = 2000 - (time - timeStamp)
                gap = gap < 0? 0 : gap
            }
            setTimeout(() => {
                localStorage.removeItem('time-stamp')
                ele.style.display = 'none'
            }, gap);
        }
        requireXlotpay()
        setTimeout(function() {
          requireLibs()
        }, 3000)

    })

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            navigator.serviceWorker.register("/service-worker.js").then(function (reg) {
                // console.log("Service worker registered.", reg);
                var script = document.createElement('script');
                script.src = '/static/utils/pwaInfo.js?v=1.39.6'
                document.body.appendChild(script);
            });
        });
    }

    window.addEventListener('error', function (e) {
        // gtag('event', 'exception', {
        //     'description': e.target? e.target.className + '-error': 'event-error',
        //     'fatal': false
        // });
        e.preventDefault()
    }, true);

    //sacle
    document.addEventListener(
        "gesturestart",
        function (event) {
            event.preventDefault();
        },
        false
    );

    var lastTouchEnd = 0;
    document.addEventListener('touchend',function (event) {
        var now=(new Date()).getTime();
        if(now-lastTouchEnd<=300){
            event.preventDefault();
        }
        lastTouchEnd=now;
    }, false)
}

// index.html 文件内资源迁移，
function requireLibs () {
  loadJs('https://vsw.betradar.com/ls/mobile/?/luckybus/en/page/vsmobile', () => {})
  loadJs('https://www.googletagmanager.com/gtag/js?id=G-Z48ZZR7C49', () => {})
  loadJs('https://cdn.aihelp.net/webchatv5/aihelp.js', () => {})
}

function requireXlotpay () {
    var script = document.createElement('script');
    script.src = '/casino/pay/static/sdk/libs/dist/xlotpaysdk.min.js?t=' + new Date().getTime();
    document.body.appendChild(script);
    setTimeout(function() {
        if (window.xlotPayer && window.xlotPayer.preLoadAction) {
            window.xlotPayer.preLoadAction();
        }
    }, 1000);
}

//-------------------------window loaded action--------------------------

window.firebaseEvent = function (eventName, params = {}) {
    if (window.firebase && typeof window.firebase.analytics == 'function') {
        var analytics = window.firebase.analytics()
        var channel = window.bangGoogle? window.bangGoogle.channel: ''
        var eventParams = Object.assign(params, { channel_name: channel })
        analytics.logEvent(eventName, eventParams)
            } else {
            }
}

// setPerfume();1
setListener();
(function () {
    init();
    initFirebase()
    initFacebook()
})();


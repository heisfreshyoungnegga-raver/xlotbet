
function initialize () {
  var date = new Date()
  var urlParams = new URLSearchParams(window.location.search);
  var isiOS = urlParams.get('iosDevices') == '1'
  var isAndriod = window.xlotbetInterface || urlParams.get('type') == 'app'
  var screenOption = JSON.parse(localStorage.getItem('page-start-loader'))
  var oldSloganSign = localStorage.getItem('slogan-sign')
  var oldScreenSign = localStorage.getItem('screen-sign')
  var betScreen = document.getElementById('bet-screen')
  var betSlogan = document.getElementById('bet-slogan')
  var betScreenImage = document.getElementById('bet-screen-image')
  var betScreenGif = document.getElementById('bet-slogan-gif')
  var sign = [date.getFullYear(), date.getMonth(), date.getDate()].join('-')
  let country = localStorage.getItem('country') || 0
  // 如果是安卓或者ios壳包内，不加载开屏图
  if (isiOS || isAndriod) return

  // 先加载slogan
  loadSlogan(loadScreen)

// 加载slogan
  function loadSlogan (callback) {
    // 第一天首次进入，分别加载slogan loading
    // 第一天二次进入，分别加载slogan 开屏图 loading
    // 第一天三次进入，加载 loading
    // 第一天一次进入，分别加载slogan 开屏图 loading
    // 第二天一次进入，加载 loading
    
      // 每天展示一次
    if (oldSloganSign != sign) {
      localStorage.setItem('slogan-sign', sign)
      if(country!=0){
        betSlogan.className = 'loading-show'
      }
      betScreenGif.onload = function () {
        localStorage.setItem('time-stamp', new Date() - 1)
        // 一秒后关闭slogan
        setTimeout(() => {
          betSlogan.className = 'loading-hide'
          callback()
        }, 1000);
      }
    } else {
      callback()
    }
  }

  function loadScreen () {
    // 每天展示一次
    if (screenOption && oldScreenSign != sign) {
      betScreen.className = 'loading-show'
      betScreenImage.src = screenOption.imageUrl
      localStorage.setItem('screen-sign', sign)
      betScreenImage.onload = function () {
        localStorage.setItem('time-stamp', new Date() - 1)
        betScreen.onclick = function () {
          var url = data.h5JumpUrl
          if (url) {
            window.location.href = url
          }
        }
        // 四秒后关闭开屏图
        setTimeout(() => {
          betScreen.className = 'loading-hide'
        }, 1000);
      }
    }
  }
}
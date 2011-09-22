/*jslint sloppy: true, white: true, plusplus: true, maxerr: 50, indent: 2 */


/*

перед тем как отдавать ссылку пользователю в tv1.php
 будем там получать ссылку на этот же поток, но для IP уже сервера iptv.hostel6.ru
 после этого делаем http-запрос из tv1.php с указанием идентификатора пользователя и ссылки на поток
 к node.js серверу
 ну и секретным паролем
 node.js сервер возвращает строку - пусто - если нет сжатого для этого потока, или ссылку на сжатый
 в tv5.js попрежнему кнопку "Включить сжатие" нужно организовать
 ну и т.д.
 таким образом, для node.js сервера ты будешь раз в 15 секунд от каждого польователя, желающего получить 
 сжатый поток получать ССЫЛКУ на исходный поток (url) и идентификатор пользователя (uid), и пароль для доступа (secret)
 а возвращать будешь ссылку на сжатый поток, либо пусто, если нет потока

 http://iptv.hostel6.ru/?secret=...&url=...&uid=...

  !!! ВАЖНО !!!
  под streamURL понимается ссылка на поток для сервера iptv.hostel6.ru, 
  таким образом, streamURL идентифицирует поток!
  
  все потоки должны быть доступны этому серверу (для сжатия)

*/


var sys = require('sys');
var http = require('http');
var fs = require('fs');
var querystring = require('querystring');
var EventEmitter = require('events').EventEmitter;
var spawn = require('child_process').spawn;



process.on('uncaughtException', function (e) {
  try {
    sys.puts('Caught exception: ' + e + ' ' + (typeof(e) === 'object' ? e.stack : ''));
  } catch(e0) {}
});



var emitter = new EventEmitter();
var secret = fs.readFileSync(__dirname + '/secret.txt', 'utf8').trim();

var launchedVLC = [];
var userVotes = {}; // uid => url
var lifeTime = 30000;//?
var vlcLimit = 6;

/* свободные порты, на которых будут потоки */
var freePorts = (function (x, i) {
  for (i = 20000; i < 20100; i++) {
    x.push(i);
  }
  return x;
}([]));



function startVLC(streamURL) {
  var y = {
    process: null,
    url: streamURL
  };
  y.port = freePorts.pop();
  y.outputURL = ':' + y.port;
  launchedVLC.push(y);

  sys.puts('launching vlc with url: ' + y.url);

  y.process = spawn('cvlc', [
    '--http-caching=1200',
    '--sout-http-mime=video/mpeg',
    '--sout',
    '#transcode{vcodec=h264,vb=256,scale=0.5,acodec=mpga,ab=96,channels=2}:std{access=http,mux=ts,dst=:' + y.port + '}',
    y.url,
    'vlc://quit'
  ]);

  emitter.emit('vlcEvent', {url: y.url, outputURL: y.outputURL});
  y.process.on('exit', function (code) {
    var r = launchedVLC.indexOf(y);
    if (r !== -1) {
      launchedVLC.splice(r, 1);//удаляем из массива запущенных
      emitter.emit('vlcEvent', {url: y.url, outputURL: y.outputURL, close: 1});
      freePorts.push(y.port);
    }
    console.log('child process exited with code ' + code);
  });
}


// функция подсчета голосов за включение сжатия для каждого url + запуска VLC
// будем запускать раз в 15 секунд
function work() {

  var results = [],  // results[i] = url + кол-во голосов
      tmp = {};
      
// Добавляем уже запущенные потоки !!! (иначе не удалятся)
  var prefix = '~~';
  launchedVLC.forEach(function (x) {
    userVotes[prefix + x.url] = x.url;
  });

  Object.keys(userVotes).forEach(function (uid) {
    var url = userVotes[uid],
        x = tmp[url];
    if (!x) {
      x = {
        votes: 0,
        url: url,
        // child process or undefined if there is no process
        vlc: launchedVLC.filter(function (x) {
          return x.url == url;
        })[0]
      };
      tmp[url] = x;
      results.push(x);
    }
    if (uid.indexOf(prefix) !== 0) {
      x.votes++;
    }
  });

  /*
    сортируем по убыванию желающих посмотреть сжатый поток + приоритет тем потокам, которые уже показываются
  */
  results.sort(function (a, b) {
    return (b.votes + 0.5 * (b.vlc ? 1 : 0)) - (a.votes + 0.5 * (a.vlc ? 1 : 0));
  });

  results.forEach(function (x, index) {
    var play = index < vlcLimit;
    if (x.vlc && !play) {
      sys.puts('kill vlc with url: ' + x.url);
      x.vlc.process.kill();
    }
    if (!x.vlc && play) {
      startVLC(x.url);
    }
  });

}


var unvoteTimers = {};
http.createServer(function (request, response) {


  if (request.url === '/iframe.html') {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end(fs.readFileSync(__dirname + '/iframe.html', 'utf8'));
    return;
  }
  
  if (request.url === '/eventsource.js') {
    response.writeHead(200, {'Content-Type': 'text/javascript'});
    response.end(fs.readFileSync(__dirname + '/eventsource.js', 'utf8'));
    return;
  }

  if (request.url === '/events') {
    function sendMessages(data) {
      response.write('data: ' + JSON.stringify(data) + '\n\n');
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, Polling, Cache-Control, Last-Event-ID',
      'Access-Control-Max-Age': '8640'
    });
    // 2 kb comment message for XDomainRequest
    response.write(':' + Array(2049).join(' ') + '\n');
    launchedVLC.forEach(function (x) {
      sendMessages({url: x.url, outputURL: x.outputURL});
    });
    emitter.addListener('vlcEvent', sendMessages);
    emitter.setMaxListeners(0);
    response.socket.on('close', function () {
      emitter.removeListener('vlcEvent', sendMessages);
      response.end();
    });
    return;
  }

  var q = require('url').parse(request.url, true);

  if (q.query.secret !== secret) {
    response.writeHead(403, {'Content-Type': 'text/html'});
    response.end('нет доступа');
    return;
  }

  var url = q.query.url;
  var uid = q.query.uid;

  userVotes[uid] = url;
  console.log('userVotes = ' + sys.inspect(userVotes));
  setTimeout(work, 1);

  if (unvoteTimers.hasOwnProperty(uid)) {
    clearTimeout(unvoteTimers[uid]);
  }
  unvoteTimers[uid] = setTimeout(function () {
    delete unvoteTimers[uid];
    delete userVotes[uid];
    setTimeout(work, 1);
  }, lifeTime);

  response.writeHead(200, {'Content-Type': 'text/html'});
  var s = launchedVLC.filter(function (r) {
    return r.url === url;
  })[0];
  response.write(s ? s.outputURL : '');
  response.end();
}).listen(8003);


console.log('server started!');
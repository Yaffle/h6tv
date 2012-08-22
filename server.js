/*jslint sloppy: true, white: true, plusplus: true, maxerr: 50, indent: 2 */

function FIFO() {
  var head = null,
      tail = null;

  this.unshift = function (data) {
    head = {
      data: data,
      next: head
    };
    (head.next || {}).prev = head;
    tail = tail || head;
  };

  this.pop = function () {
    var item = tail || {};
    tail = item.prev;
    (item.prev || {}).next = null;
    head = tail && head;
    return item.data;
  };

  return this;
}

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
*/


var util = require('util');
var http = require('http');
var fs = require('fs');
var querystring = require('querystring');
var EventEmitter = require('events').EventEmitter;
var spawn = require('child_process').spawn;


process.on('uncaughtException', function (e) {
  try {
    util.puts('Caught exception: ' + e + ' ' + (typeof(e) === 'object' ? e.stack : ''));
  } catch(e0) {}
});

setInterval(function () {
  emitter.emit('ping');
}, 5000);

var emitter = new EventEmitter();
var secret = fs.readFileSync(__dirname + '/secret.txt', 'utf8').trim();

var launchedVLC = [];
var userVotes = {}; // uid => url
var lifeTime = 30000;//?
var vlcLimit = 5;

var freePorts = new FIFO();/* свободные порты, на которых будут потоки */

(function () {
  var i;
  for (i = 20001; i < 20100; i++) {
    freePorts.unshift(i);
  }
}());


// функция подсчета голосов за включение сжатия для каждого url + запуска VLC
// будем запускать раз в 15 секунд
function work() {

  var results = []; // results[i] = url + кол-во голосов
  Object.keys(userVotes).forEach(function (vote) {
    var url = userVotes[vote];
    var c = results.filter(function (r) {
      return r.url === url;
    })[0];
    if (!c) {
      c = {
        url: url,
        votes: 0
      };
      results[results.length] = c;
    }
    c.votes++;
  });

  results.forEach(function (x) {
    x.worksNow = false;
    launchedVLC.forEach(function (y) {
      x.worksNow = x.worksNow || y.url === x.url;
    });
  });

  
  /*
    сортируем по убыванию желающих посмотреть сжатый поток + приоритет тем потокам, которые уже показываются
  */
  results.sort(function (a, b) {
    if (a.votes === b.votes) {
      return a.worksNow && b.worksNow ? 0 /* ?? не должно быть 0 */ : (a.worksNow ? -1 : 1);
    }
    return b.votes - a.votes;
  });
  
  // делаем из results массив ссылок
  results = results.map(function (x) {
    return x.url;
  });

  results = results.slice(0, vlcLimit);//!


  // ненужные выключаем
  launchedVLC = launchedVLC.filter(function (x) {
    var r = results.indexOf(x.url);
    if (r === -1) {
      util.puts('kill vlc with url: ' + x.url);
      x.process.kill();
      emitter.emit('vlcEvent', {url: x.url, outputURL: x.outputURL, close: 1});
      freePorts.unshift(x.port);//!? нужно ли освобождать здесь? в on('exit') уже, тем более здесь порт еще не свободен
    } else {
      results.splice(r, 1); // удаляем ссылку из массива, т.к. vlc уже запущен, нам не нужен еще один с таким же url
    }
    return r !== -1;
  });

  // results содержит VLC
  while (launchedVLC.length < vlcLimit && results.length) {
    var y = {
      process: null,
      url: results.pop()
    };
    y.port = freePorts.pop();
    y.outputURL = ':' + y.port;
    launchedVLC.push(y);
    (function (y) {
      util.puts('launching vlc with url: ' + y.url);
//      y.process = spawn('cvlc', ['--sout-http-mime=video/mpeg','--http-caching=1200', '--sout', '#transcode{vcodec=h264,vb=576,width=360,height=288,acodec=mp4a,ab=96,channels=2}:std{access=http,mux=ts,dst=:' + y.port + '}', y.url,'vlc://quit']);
      y.process = spawn('cvlc', ['--sout-http-mime=video/mpeg','--http-caching=1200', '--sout', '#transcode{vcodec=h264,vb=400,scale=0.5,acodec=mp4a,ab=32,channels=2}:std{access=http,mux=ts,dst=:' + y.port + '}', y.url,'vlc://quit']);
      emitter.emit('vlcEvent', {url: y.url, outputURL: y.outputURL});
      y.process.on('exit', function (code) {
        var r = launchedVLC.indexOf(y);
        if (r !== -1) {
          launchedVLC.splice(r, 1);//удаляем из массива запущенных
          emitter.emit('vlcEvent', {url: y.url, outputURL: y.outputURL, close: 1});
          freePorts.unshift(y.port);
        }
    //    console.log('child process exited with code ' + code);
      });
    }(y));

  }

}


var unvoteTimers = {};

function onHttpConnection(request, response) {

  if (request.url === '/events') {
    function sendMessages(data) {
      response.write('data: ' + JSON.stringify(data) + '\n\n');
    }
    function sendComment() {
      response.write(':\n');//нужен комментарий раз в 15-30 секунд, чтобы соединение не прерывалось EventSource'ом
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    //response.connection.setTimeout(0); // this could take a while

    if ((request.headers.accept || '').indexOf('text/event-stream') === -1) {
      // 2 kb comment message for XDomainRequest (IE8, IE9)
      response.write(':' + Array(129).join('0123456789ABCDEF') + '\n');
    } else {
      response.write('\n\n'); // we should send something (for Opera - "\n\n")
    }

    emitter.addListener('vlcEvent', sendMessages);
    emitter.addListener('ping', sendComment);
    emitter.setMaxListeners(0);
    response.socket.on('close', function () {
      emitter.removeListener('vlcEvent', sendMessages);
      emitter.removeListener('ping', sendComment);
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

    if (q.query.adm == secret) {
        userVotes[uid] = url;
        return;
    }

  userVotes[uid] = url;
  console.log('userVotes = ' + util.inspect(userVotes));
  setTimeout(work, 1);

  if (unvoteTimers.hasOwnProperty(uid)) {
    clearTimeout(unvoteTimers[uid]);
  }
  unvoteTimers[uid] = setTimeout(function () {
    unvoteTimers[uid] = null;
    delete userVotes[uid];
    setTimeout(work, 1);
  }, lifeTime);

  response.writeHead(200, {'Content-Type': 'text/html'});
  var s = launchedVLC.filter(function (r) {
    return r.url === url;
  })[0];
  response.write(s ? s.outputURL : '');
  response.end();
}

http.createServer(onHttpConnection).listen(8003);

var path = require('path');
path.exists(file, function(exists) {
  if (exists) {
    // serve file
    spawn('certificate');
  }
  require('https').createServer({
    key: fs.readFileSync('server-key.pem'),
    cert: fs.readFileSync('server-cert.pem')
  }, onHttpConnection).listen(8033);
});

console.log('server started!');

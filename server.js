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
var userVotes = []; // uid, url, timeStamp
var lifeTime = 15000;

var counter = 0;

// функция подсчета голосов за включение сжатия для каждого url + запуска VLC
// будем запускать раз в 15 секунд
function work() {

  vote();
   
  var results = []; // results[i] = url + кол-во голосов
  userVotes.forEach(function (vote) {
    var c = results.filter(function (r) {
      return r.url === vote.url;
    })[0];
    if (!c) {
      c = {
        url: vote.url,
        votes: 0
      };
      results[results.length] = c;
    }
    c.votes++;
  });
  
  results.sort(function (a, b) {
    return a.votes > b.votes;
  });
  
  // делаем из results массив ссылок
  results = results.map(function (x) {
    return x.url;
  });

  results = results.slice(0, 4);// оставляем первые 4!


  // ненужные выключаем
  launchedVLC = launchedVLC.filter(function (x) {
    var r = results.indexOf(x.url) !== -1;
    if (!r) {
      x.process.kill();
    } else {
      results.splice(r, 1); // удаляем ссылку из массива, т.к. vlc уже запущен, нам не нужен еще один с таким же url
    }
    return r;
  })
  
  // results содержит VLC
  while (launchedVLC.length < 4 && results.length) {
    var y = {
      process: null,
      url: results.pop(),
      outputURL: 'http://iptv.hostel6.ru:' + (20000 + counter)
    };
    counter = (counter + 1) % 1000;
    launchedVLC.push(y);
    (function (y) {
      sys.puts('launching vlc with url: ' + y.url);
      y.process = spawn('ls', ['-lh', '/usr']);
      y.process.on('exit', function (code) {
        var r = launchedVLC.indexOf(y);
        if (r !== -1) {
          launchedVLC.splice(r, 1);//удаляем из массива запущенных
        }
        console.log('child process exited with code ' + code);
      });
    }(y));

  }

  setTimeout(work, 15000);
}

function vote(url, uid) {
  var timeStamp = +new Date();
  var usedUIDs = {};
  if (url && uid) {
    userVotes.push({
      timeStamp: timeStamp,
      url: url,
      uid: uid
    });
  }
  // дубли по uid удаляются, обновляется время и url для текущего uid, старые фильтруются
  userVotes = userVotes.filter(function (x) {
    if (x.uid === uid) {
      // update
      x.timeStamp = timeStamp;
      x.url = url;
    }
    var r = !usedUIDs.hasOwnProperty(x.uid) && (x.timeStamp + lifeTime > timeStamp);
    usedUIDs[x.uid] = 1;
    return r;
  });
  
  console.log('userVotes = ' + sys.inspect(userVotes));
}

work();

http.createServer(function (request, response) {
  var q = require('url').parse(request.url, true);

  if (q.query.secret !== secret) {
    response.writeHead(403, {'Content-Type': 'text/html'});
    response.end('нет доступа');
    return;
  }

  var url = q.query.url;
  var uid = q.query.uid;

  vote(url, uid);

  response.writeHead(200, {'Content-Type': 'text/html'});
  var s = launchedVLC.filter(function (r) {
    return r.url === url;
  })[0];
  response.write(s ? s.outputURL : '');
  response.end();
}).listen(8003);


console.log('server started!');

require('dotenv').config();

var crypto = require('crypto');
var url_parser = require('url');
const logger = require('winston');
const IORedis = require('ioredis');
const { promisify } = require('util');

const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

const redisClient1 = new IORedis({
  port: process.env.REDIS_SERVER_PORT,
  host: process.env.REDIS_SERVER_HOST1,
  db: process.env.REDIS_SERVER_DB_EVENTS_ODD
});

const redisClient2 = new IORedis({
  port: process.env.REDIS_SERVER_PORT,
  host: process.env.REDIS_SERVER_HOST2,
  db: process.env.REDIS_SERVER_DB_EVENTS_FANCY
});

const redisClient3 = new IORedis({
  port: process.env.REDIS_SERVER_PORT,
  host: process.env.REDIS_SERVER_HOST3,
  db: process.env.REDIS_SERVER_DB_EVENTS
});

const redisClientLocal = new IORedis({
  port: process.env.REDIS_LOCAL_SERVER_PORT,
  host: process.env.REDIS_LOCAL_SERVER_HOST,
  db: process.env.REDIS_LOCAL_SERVER_DB
});

// Using Promisify to use async/await for get and set
const getRedisClient3Async = promisify(redisClient3.get).bind(redisClient3);
const setRedisClient3Async = promisify(redisClient3.set).bind(redisClient3);

redisClient1.on('connect', function () {
  logInfo('Redis redisClient1 connected');
});

redisClient2.on('connect', function () {
  logInfo('Redis redisClient2 connected');
});

redisClient3.on('connect', function () {
  logInfo('Redis redisClient3 connected');
});

redisClient1.on('error', function (err) {
  logError('Something went wrong ' + err);
});

redisClient2.on('error', function (err) {
  logError('Something went wrong ' + err);
});

redisClient3.on('error', function (err) {
  logError('Something went wrong ' + err);
});

redisClientLocal.on('connect', function () {
  logInfo('Redis local client connected in Shared Functions local');
});

redisClientLocal.on('error', function (err) {
  logError('Something went wrong in Shared Functions local' + err);
});

logger.configure({
  format: logger.format.combine(
    logger.format.timestamp(),
    logger.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level}: ${message}`;
    })
  ),
  transports: [
    new logger.transports.Console()
  ]
});

var algorithm = 'aes-256-cbc';
var key = process.env.EVENT_SECRET_KEY;
var iv = process.env.EVENT_SECRET_IV;

async function logInfo(message, isForceShow = false) {
  try {
    const shouldLog = isForceShow
      ? await getRedisClient3Async('isForceShowLog') == 'true'
      : process.env.ENV_LOG_ENABLE === 'true';

    if (shouldLog) {
      logger.info(message);
    }
  } catch (error) {
    console.error("Error in logInfo:", error);
  }
};

async function logError(message, isForceShow = false) {
  try {
    const shouldLog = isForceShow
      ? await getRedisClient3Async('isForceShowLog') == 'true'
      : process.env.ENV_LOG_ENABLE === 'true';

    if (shouldLog) {
      logger.error(message);
    }
  } catch (error) {
    console.error("Error in logError:", error);
  }
};

referer_url = function (http_url) {
  if (http_url) {
    return url_parser.parse(http_url).hostname;
  } else {
    return '';
  }
};

encrypt = function (text) {
  var cipher = crypto.createCipheriv(algorithm, key, iv)
  var crypted = cipher.update(text, 'utf-8', "base64")
  crypted += cipher.final("base64");
  return crypted;
};

decrypt = function (text) {
  if (text) {
    var cipher = crypto.createDecipheriv(algorithm, key, iv)
    var crypted = cipher.update(text, "base64", "utf-8")
    crypted += cipher.final("utf-8");
    return crypted;
  } else {
    return '';
  }
};


function sleep(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

hmacHash = function (text) {
  hash = crypto.createHmac('sha256', process.env.EVENT_SECRET_KEY).update(text);
  return hash.digest('base64');
}

isJsonString = function (data) {

  try {
    if (typeof data === 'object' && data !== null) {
      return data;
    }

    var o = JSON.parse(data);
    if (o && typeof o === "object") {
      return o;
    }

    if (o && typeof o === "string") {
      var o = JSON.parse(o);
      return o;
    }

  }
  catch (e) {
    logInfo("JSON error: " + data)
  }
  return false;
}

isEmpty = function (val) {
  if (val === undefined)
    return true;

  if (typeof (val) == 'function' || typeof (val) == 'number' || typeof (val) == 'boolean' || Object.prototype.toString.call(val) === '[object Date]')
    return false;

  if (val == null || val.length === 0)        // null or 0 length array
    return true;

  if (typeof (val) == "object") {
    // empty object

    var r = true;

    for (var f in val)
      r = false;

    return r;
  }

  return false;
}

async function postData(url = '', data = {}, headers = {}, proxyUrl = null) {
  try {
    const axiosConfig = {
      method: 'post',
      url: url,
      data: data,
      headers: headers,
      timeout: 5000
    };

    if (proxyUrl) {
      axiosConfig.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);
      axiosConfig.proxy = false; // Disable axios' default proxy handling
    }

    const response = await axios(axiosConfig);
    return response.data;

  } catch (error) {
    logError(`Error in postData: ${error}`);
    if (error.response) {
      logError(error.response.data);
      logError(error.response.status);
      logError(error.response.headers);
    }
    return false;
  }
}

async function getData(url = '', params = {}, headers = {}, proxyUrl = null) {
  try {
    const axiosConfig = {
      method: 'get',
      url: url,
      params: params,
      headers: headers,
      timeout: 20000
    };

    if (proxyUrl) {
      axiosConfig.httpsAgent = new HttpsProxyAgent.HttpsProxyAgent(proxyUrl);
      axiosConfig.proxy = false; // Disable axios' default proxy handling
    }

    const response = await axios(axiosConfig);
    return response.data;

  } catch (error) {
    logError(`Error in getData: ${error}`);
    if (error.response) {
      logError(error.response.data);
      logError(error.response.status);
      logError(error.response.headers);
    }
    return false;
  }
}

function timeDiff(startTime, endTime, diffType = 'minutes') {
  const differenceInMilliseconds = endTime - startTime;
  let diff = 0;
  if (diffType == "seconds") {
    diff = differenceInMilliseconds / 1000;
  } else if (diffType == "minutes") {
    diff = differenceInMilliseconds / 60000;
  }

  return diff.toFixed(2);
}

let proxySettings = {};
let proxySettingsUrl = '';
if (process.env.PROXY_ENABLE == "true") {
  proxySettings = {
    host: process.env.PROXY_HOST,
    port: process.env.PROXY_PORT
  }

  proxySettingsUrl = `http://${proxySettings.host}:${proxySettings.port}`;
}



let bfProxySettings = {};
if (process.env.PROXY_BF_ENABLE == "true") {
  var proxyUrl = "http://" + process.env.PROXY_BF_HOST + ":" + process.env.PROXY_BF_PORT;
  if (process.env.PROXY_USER) {
    var proxyUrl = "http://" + process.env.PROXY_BF_USER + ":" + process.env.PROXY_BF_PASSWORD + "@" + process.env.PROXY_BF_HOST + ":" + process.env.PROXY_BF_PORT;
  }

  bfProxySettings = { 'proxy': proxyUrl }
}


let rotatingProxySettings = {};
let rotatingProxySettingsUrl = '';
if (process.env.ROTATING_PROXY_ENABLE == "true") {
  rotatingProxySettings = {
    protocol: 'http',
    host: process.env.ROTATING_PROXY_HOST,
    port: process.env.ROTATING_PROXY_PORT,
    auth: {
      username: process.env.ROTATING_PROXY_USER,
      password: process.env.ROTATING_PROXY_PASSWORD
    }
  }

  rotatingProxySettingsUrl = "http://" + process.env.ROTATING_PROXY_USER + ":" + process.env.ROTATING_PROXY_PASSWORD + "@" + process.env.ROTATING_PROXY_HOST + ":" + process.env.ROTATING_PROXY_PORT;
}

exports.logInfo = logInfo;
exports.logError = logError;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.sleep = sleep;
exports.hmacHash = hmacHash;
exports.isJsonString = isJsonString;
exports.referer_url = referer_url;
exports.postData = postData;
exports.getData = getData;
exports.timeDiff = timeDiff;

exports.proxySettings = proxySettings;
exports.proxySettingsUrl = proxySettingsUrl;
exports.bfProxySettings = bfProxySettings;
exports.rotatingProxySettings = rotatingProxySettings;
exports.rotatingProxySettingsUrl = rotatingProxySettingsUrl;

exports.redisClient1 = redisClient1;
exports.redisClient2 = redisClient2;
exports.redisClient3 = redisClient3;
exports.redisClientLocal = redisClientLocal;
"use strict";

const errorLog = require("./error-log.cjs");

globalThis.__tradeappErrorLog = errorLog.install();

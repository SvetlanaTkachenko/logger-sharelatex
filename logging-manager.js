/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS203: Remove `|| {}` from converted for-own loops
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */

const bunyan = require('bunyan');
const request = require('request');

const LOG_METHODS = [
	'debug', 'info', 'log', 'error', 'err', 'warn', 'fatal'
]

class Logger {

	constructor(name) {
		const isProduction = (process.env['NODE_ENV'] || '').toLowerCase() === 'production';
		this.defaultLevel = process.env['LOG_LEVEL'] || (isProduction ? "warn" :  "debug");
		this.loggerName = name;
		this.logger = bunyan.createLogger({
			name,
			serializers: bunyan.stdSerializers,
			level: this.defaultLevel
		});
		if (isProduction) {
			// check for log level override on startup
			this.checkLogLevel();
			// re-check log level every minute
			const checkLogLevel = () => this.checkLogLevel();
			setInterval(checkLogLevel, 1000 * 60);
		}
		return this;		
	}

	checkLogLevel() {
		const options = {
			headers: {
				"Metadata-Flavor": "Google"
			},
			uri: `http://metadata.google.internal/computeMetadata/v1/project/attributes/${this.loggerName}-setLogLevelEndTime`
		};
		return request(options, (err, response, body) => {
			if (parseInt(body) > Date.now()) {
				return this.logger.level('trace');
			} else {
				return this.logger.level(this.defaultLevel);
			}
		});
	}

	initializeErrorReporting(sentry_dsn, options) {
		const raven = require("raven");
		this.raven = new raven.Client(sentry_dsn, options);
		this.lastErrorTimeStamp = 0; // for rate limiting on sentry reporting
		return this.lastErrorCount = 0;
	}

	captureException(attributes, message, level) {
		// handle case of logger.error "message"
		let key, value;
		if (typeof attributes === 'string') {
			attributes = {err: new Error(attributes)};
		}
		// extract any error object
		let error = attributes.err || attributes.error;
		// avoid reporting errors twice
		for (key in attributes) {
			value = attributes[key];
			if (value instanceof Error && value.reportedToSentry) { return; }
		}
		// include our log message in the error report
		if ((error == null)) {
			if (typeof message === 'string') { error = {message}; }
		} else if (message != null) {
			attributes.description = message;
		}
		// report the error
		if (error != null) {
			// capture attributes and use *_id objects as tags
			const tags = {};
			const extra = {};
			for (key in attributes) {
				value = attributes[key];
				if (key.match(/_id/) && (typeof value === 'string')) { tags[key] = value; }
				extra[key] = value;
			}
			// capture req object if available
			const { req } = attributes;
			if (req != null) {
				extra.req = {
					method: req.method,
					url: req.originalUrl,
					query: req.query,
					headers: req.headers,
					ip: req.ip
				};
			}
			// recreate error objects that have been converted to a normal object
			if (!(error instanceof Error) && (typeof error === "object")) {
				const newError = new Error(error.message);
				for (key of Object.keys(error || {})) {
					value = error[key];
					newError[key] = value;
				}
				error = newError;
			}
			// filter paths from the message to avoid duplicate errors in sentry
			// (e.g. errors from `fs` methods which have a path attribute)
			try {
				if (error.path) { error.message = error.message.replace(` '${error.path}'`, ''); }
			} catch (error1) {}
			// send the error to sentry
			try {
				this.raven.captureException(error, {tags, extra, level});
				// put a flag on the errors to avoid reporting them multiple times
				return (() => {
					const result = [];
					for (key in attributes) {
						value = attributes[key];
						if (value instanceof Error) { result.push(value.reportedToSentry = true); } else {
							result.push(undefined);
						}
					}
					return result;
				})();
			} catch (error2) {
				return;
			}
		}
	}

	debug() {
		return this.logger.debug.apply(this.logger, arguments);
	}

	info(){
		return this.logger.info.apply(this.logger, arguments);
	}

	log(){
		return this.logger.info.apply(this.logger, arguments);
	}

	error(attributes, message, ...args){
		this.logger.error(attributes, message, ...Array.from(args));
		if (this.raven != null) {
			const MAX_ERRORS = 5; // maximum number of errors in 1 minute
			const now = new Date();
			// have we recently reported an error?
			const recentSentryReport = (now - this.lastErrorTimeStamp) < (60 * 1000);
			// if so, increment the error count
			if (recentSentryReport) {
				this.lastErrorCount++;
			} else {
				this.lastErrorCount = 0;
				this.lastErrorTimeStamp = now;
			}
			// only report 5 errors every minute to avoid overload
			if (this.lastErrorCount < MAX_ERRORS) {
				// add a note if the rate limit has been hit
				const note = (this.lastErrorCount+1) === MAX_ERRORS ? "(rate limited)" : "";
				// report the exception
				return this.captureException(attributes, message, `error${note}`);
			}
		}
	}

	err() {
		return this.error.apply(this, arguments);
	}

	warn(){
		return this.logger.warn.apply(this.logger, arguments);
	}

	fatal(attributes, message, callback) {
		if (callback == null) { callback = function() {}; }
		this.logger.fatal(attributes, message);
		if (this.raven != null) {
			var cb = function(e) { // call the callback once after 'logged' or 'error' event
				callback();
				return cb = function() {};
			};
			this.captureException(attributes, message, "fatal");
			this.raven.once('logged', cb);
			return this.raven.once('error', cb);
		} else {
			return callback();
		}
	}
}

let defaultLogger
// initialize default logger if not already initialized
if (!global.__logger_sharelatex__default_logger__) {
	global.__logger_sharelatex__default_logger__ = defaultLogger = new Logger("default-sharelatex")
}
else {
	defaultLogger = global.__logger_sharelatex__default_logger__
}

// support old interface for creating new Logger instances
Logger.initialize = function initialize(name) {
	return new Logger(name)
}
// add a static method for each log method that will use the default logger
for (const logMethod of LOG_METHODS) {
	Logger[logMethod] = function () {
		return defaultLogger[logMethod].apply(defaultLogger, arguments)
	}
}
// return default logger
Logger.defaultLogger = function defaultLogger () {
	return defaultLogger
}

module.exports = Logger
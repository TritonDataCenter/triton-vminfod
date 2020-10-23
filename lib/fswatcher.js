/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * This module exists to watch files for changes. It is somewhat similar to
 * node's fs.watch except:
 *
 *  * FsWatcher.watch() is asynchronous and optionally can call a callback when
 *    it actually starts watching.
 *  * FsWatcher works with files that do not exist yet, notifying you when they
 *    are created.
 *
 * To use you should do something like:
 *
 *  var fsw = new FsWatcher({log: log});
 *  fsw.on(<event type>, callback(event));
 *  fsw.watch('/path/to/some/file', function (err) { ... });
 *  fsw.unwatch('/path/to/some/file', function (err) { ... });
 *  fsw.status(function (err, obj) { ... });
 *  fsw.stop();
 *
 * Where the event types can be:
 *
 *  * event - for any event
 *  * change - emitted when a file is modified
 *  * delete - emitted when a file is deleted
 *
 * This module is a wrapper around the node fs.watcher API.
 *
 * When a file watch is attempted, if it succeeds, the callback is fired
 * immediately
 * and any new events for the file will be emitted when they are seen.  If
 * it fails however, a successful callback is still fired, but the file
 * is moved to a retry "interval".  The term interval is used here, but it's
 * actually a JavaScript setTimeout under the hood that calls itself as part
 * of the retry logic.
 *
 * The common case is, when a .watch() command is given, the file we want to
 * watch either exists or will exist very soon.  Because of this, if the initial
 * watch fails, that file specifically will be retried
 * 10 times every 200ms - this is called the
 * INITIAL_WATCH_INTERVAL.  If it succeeds during this time, the timeout will
 * be cleared and any watch events will be passed to the callback handler.
 *
 * If the file fails the INITIAL_WATCH_INTERVAL, it will move over to the
 * LONG_WATCH_INTERVAL.  This is an interval (again, actually a setTimeout
 * that calls itself when finished) that runs every 10 seconds to retry every
 * file that does not yet exist.  This is a single interval that runs every
 * 10 seconds no matter what, and loops every file that we want to watch but
 * does not yet exist.  When a fs.watch() call succeeds for a file in this
 * interval it is removed from the "not_yet_watching" list and added to the
 * "watching" list.
 */

var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var vasync = require('vasync');

var hrtime = require('./hrtime');


/*
 * when a file is watched but does not yet exist, FsWatcher will default to
 * retry watching the file INITIAL_WATCH_TRIES (10) tries every
 * INITIAL_WATCH_DELAY (200) milliseconds before transitioning the file to the
 * long watch interval.
 */
var INITIAL_WATCH_DELAY = 200;
var INITIAL_WATCH_TRIES = 10;

/*
 * when a file fails to be watched during its own initial watch interval it
 * will be transferred to a longer class-wide interval that tries to watch all
 * unwatched files every LONG_WATCH_DELAY (10000) milliseconds.
 */
var LONG_WATCH_DELAY = 10 * 1000;

// fswatcher.c can handle 2^64, but to be safe with JavaScript we restrict the
// maximum key.
var FSWATCHER_MAX_KEY = Math.pow(2, 32);

// illegal characters for filenames - this limitation is in fswatcher.c
var ILLEGAL_FILENAME_CHARS = ['\n', '\0'];

// number of fswatcher stderr lines to hold in memory
var FSWATCHER_STDERR_LINES = 100;

// number of messages to store to calculate delay
var MESSAGE_DELAY_BUFFER_SIZE = 1000;

// minimum allowable time in ms before a warning log is emitted
var MESSAGE_DELAY_LOG_THRESHOLD = 10;

// default logger if left unspecified
var LOG = bunyan.createLogger({
    level: 'debug',
    name: 'fswatcher',
    streams: [
    {
        stream: process.stderr,
        level: 'trace'
    }
    ],
    serializers: bunyan.stdSerializers
});

function noop() {}

/*
 * Create an FsWatcher instance
 */
function FsWatcher(opts) {
    var self = this;

    EventEmitter.call(self);

    opts = opts || {};
    self.log = opts.log || LOG;

    assert.object(opts, 'opts');
    assert.object(self.log, 'opts.log');
    assert.optionalBool(opts.dedup, 'opts.dedup');
    assert.optionalNumber(opts.initial_watch_delay,
        'opts.initial_watch_delay');
    assert.optionalNumber(opts.initial_watch_tries,
        'opts.initial_watch_tries');
    assert.optionalNumber(opts.long_watch_delay, 'opts.long_watch_delay');

    // turned on when .stop() is issue and off when the process exits
    self.stopping = false;

    // if we should dedup events from the same time (millisecond resolution)
    self.dedup = opts.dedup;

    // files currently being watched
    self.watching = {};

    // files that need to be watched but don't exist yet
    self.not_yet_watching = {};

    // fswatcher stderr lines generated
    self.stderr_buffer = new bunyan.RingBuffer({limit: FSWATCHER_STDERR_LINES});

    // time delta from when messages are generated by fswatcher.c, to when they
    // are processed by this module.
    self.message_delay_buffer = new bunyan.RingBuffer({
        limit: MESSAGE_DELAY_BUFFER_SIZE
    });

    // see comments at the top of this file for "default values" for information
    // on these variables
    self.initial_watch_delay = opts.initial_watch_delay || INITIAL_WATCH_DELAY;
    self.initial_watch_tries = opts.initial_watch_tries || INITIAL_WATCH_TRIES;
    self.long_watch_delay = opts.long_watch_delay || LONG_WATCH_DELAY;
    /*
    * start the long interval
    */
    /*
     * We store the previous event seen to use for deduplication purposes -
     * if the same exact event is seen within the same millisecond every event
     * after the first is thrown out.
     */
    self.prev_event = null;

    // no matter what, this loop runs to watch any unwatched files
    function long_watch_interval() {
        self._watchUnwatchedFiles(function _watchUnwatchedFilesDone() {
            self.long_watch_timeout = setTimeout(long_watch_interval,
                self.long_watch_delay);
        });
    }
    self.long_watch_timeout = setTimeout(long_watch_interval,
        self.long_watch_delay);

    /*
     * This queue handles events from fs.watch().
     */
    self.res_queue = vasync.queue(function stdoutQueue(obj, cb) {
        var err;
        var delta;
        var ms1;
        var ms2;
        var obj;

        if (!self.isRunning()) {
            self.log.warn({obj: obj}, 'fs event received while not running');
            cb();
            return;
        }

        self.log.trace({obj: obj}, 'fswatcher event');

        if (self.dedup && self.prev_event !== null) {
            // convert both monotonic timers to milliseconds for dedup purposes
            ms1 = jsprim.hrtimeMillisec(obj.time);
            ms2 = jsprim.hrtimeMillisec(self.prev_event.time);

            if (self.prev_event.pathname === obj.pathname
                && self.prev_event.type === obj.type
                && ms1 === ms2) {

                self.log.debug({obj: obj}, 'discarding duplicate object');
                process.nextTick(cb);
                return;
            }
        }
        self.prev_event = jsprim.deepCopy(obj);

        delta = jsprim.hrtimeMillisec(process.hrtime(obj.time));
        self.message_delay_buffer.write(delta);
        if (delta > MESSAGE_DELAY_LOG_THRESHOLD) {
            self.log.warn({deltaMs: delta, avg: self.messageDelays()},
                'message took %dms to process (> %dms)',
                delta, MESSAGE_DELAY_LOG_THRESHOLD);
        }

        switch (obj.type) {
            case 'change':
            case 'rename':
                var w = self.watching[obj.pathname];
                assert.object(w, 'not watching ' + obj.pathname);

                // XXX: Why two events?
                self.emit(obj.type, obj);
                self.emit('event', obj);
                break;
            default:
                err = new Error('dispatching error');
                self.log.warn({err: err, obj: obj}, err.message);
                throw err;
        }
        process.nextTick(cb);
    }, 1);
}
util.inherits(FsWatcher, EventEmitter);

/*
 * stop watching everything
 */
FsWatcher.prototype.stop = function stop() {
    var self = this;

    assert(self.isRunning(), 'not running');

    self.stopping = true;

    // unwatch all files

    // clear all watches that haven't been established yet
    Object.keys(self.not_yet_watching).forEach(function clearNotYetWatching(f) {
        var o = self.not_yet_watching[f];
        if (o.timeout) {
            clearTimeout(o.timeout);
            o.timeout = null;
        }
    });

    // clear all active file watches
    Object.keys(self.watching).forEach(function clearWatching(f) {
        var o = self.watching[f];
        assert.object(o.handle, 'o.handle');
        o.handle.close();
    });

    self.not_yet_watching = {};
    self.watching = {};

    // stop the long_watch_interval
    clearTimeout(self.long_watch_timeout);
    self.long_watch_timeout = null;
};

/*
 * watch a file
 */
FsWatcher.prototype.watch = function watch(f, cb) {
    var self = this;
    cb = cb || noop;

    assert(self.isRunning(), 'not running');
    assert.string(f, 'filename unspecified');
    assert.func(cb, 'cb');

    // validate filename
    var e = self._validFilename(f);
    if (e) {
        cb(e);
        return;
    }

    /*
     * callback with an error if we've already been instructed to watch this
     * file
     */
    if (self._isWatching(f)) {
        cb(new Error('already watchng ' + f));
        return;
    }

    /*
     * all new files start off in the 'not_yet_watching' bucket and are moved
     * to the 'watching' bucket when/if a call to `fs.watch(f)` is successful
     */
    self.not_yet_watching[f] = {
        tries: 0,
        timeout: null,
        long_watch: false
    };

    /*
     * try to watch the file - this function will call itself multiple times
     * based on the values set in the constructor if it fails before moving the
     * file to the long interval
     */
    tryWatching(cb);

    function tryWatching(next) {
        var handle;
        var o = self.not_yet_watching[f];

        /*
         * watch was cancelled (probably shutting down or told to unwatch),
         * just give up
         */
        if (o === undefined) {
            next();
            return;
        }

        o.timeout = null;

        /*
         * we've tried too many times, just give up and let the long interval
         * catch it
         */
        if (o.tries >= self.initial_watch_tries) {
            self.log.trace('%s exceeded max tries, moving to long interval', f);
            o.long_watch = true;
            next();
            return;
        }

        try {
            handle = fs.watch(f, function _onFsWatchCb(eventType, _filepath) {
                // self.log.trace('watch event %s fired for %s', eventType, f);
                self.res_queue.push({
                    pathname: f,
                    time: process.hrtime(),
                    type: eventType,
                });
            });
        } catch (ex) {
            o.tries++;
            o.timeout = setTimeout(tryWatching, self.initial_watch_delay, noop);
            self.log.trace('%d/%d %s watch failed: %s',
                o.tries, self.initial_watch_tries, f, ex);
            next();
            return;
        }

        // watch succeeded!
        self.watching[f] = {
            handle: handle
        };
        delete self.not_yet_watching[f];

        self.log.trace('%d/%d %s watch succeeded',
            o.tries, self.initial_watch_tries, f);

        next();
    }
};

/*
 * stop watching a file
 */
FsWatcher.prototype.unwatch = function unwatch(f, cb) {
    var self = this;
    cb = cb || noop;

    assert(self.isRunning(), 'not running');
    assert.string(f, 'filename unspecified');
    assert.func(cb, 'cb');

    // validate filename
    var e = self._validFilename(f);
    if (e) {
        cb(e);
        return;
    }

    if (self.watching[f]) {
        assert.object(self.watching[f].handle, 'self.watching[f].handle');
        self.watching[f].handle.close();
        delete self.watching[f];
        cb();
        return;
    }

    if (self.not_yet_watching[f]) {
        if (self.not_yet_watching[f].timeout) {
            clearTimeout(self.not_yet_watching[f].timeout);
            self.not_yet_watching[f].timeout = null;
        }
        delete self.not_yet_watching[f];
        cb();
        return;
    }

    cb(new Error('not watching ' + f));
};

/*
 * Get child process status
 */
FsWatcher.prototype.status = function status(cb) {
    var self = this;

    assert(self.isRunning(), 'not running');
    assert.func(cb, 'cb');

    self._sendCommand('STATUS', cb);
};


/*
 * check if we are, or were instructed to, watch a file
 */
FsWatcher.prototype._isWatching = function _isWatching(f) {
    var self = this;

    assert.object(self.watching, 'self.watching');
    assert.object(self.not_yet_watching, 'self.not_yet_watching');

    return jsprim.hasKey(self.watching, f)
        || jsprim.hasKey(self.not_yet_watching, f);
};

/*
 * validate a filename string
 *
 * returns null on success or an Error object on failure
 */
FsWatcher.prototype._validFilename = function _validFilename(f) {
    try {
        ILLEGAL_FILENAME_CHARS.forEach(function checkFilename(c) {
            assert.equal(f.indexOf(c), -1, 'filename contains bad char ' + c);
        });
    } catch (e) {
        return e;
    }
    return null;
};

/*
 * try to watch all unwatched files - this will be called at an interval
 * specified in the constructor options or at a default of every 10 seconds
 */
FsWatcher.prototype._watchUnwatchedFiles =
    function _watchUnwatchedFiles(cb) {

    var self = this;

    assert.object(self.not_yet_watching, 'self.not_yet_watching');

    var started_watching = 0;
    var still_waiting = 0;
    var then = process.hrtime();
    var not_yet_watching_keys = Object.keys(self.not_yet_watching);

    vasync.forEachParallel({
        inputs: not_yet_watching_keys,
        func: function watchUnwatchedFile(f, cb2) {
            var handle;
            var o = self.not_yet_watching[f];

            // this interval only looks for files that are in the "long_watch"
            // bucket
            if (!o || !o.long_watch) {
                cb2();
                return;
            }

            try {
                handle = fs.watch(f, function _onFsWatchCb(eType, filepath) {
                    self.res_queue.push({
                        pathname: filepath,
                        time: process.hrtime(),
                        type: eType,
                    });
                });
            } catch (ex) {
                self.log.trace('long watch failed for file %s', f);
                cb2();
                return;
            }
    
            // watch succeeded! we can now emit a 'create' event
            // and stop waiting on this file to exist
            self.watching[f] = {
                handle: handle
            };
            delete self.not_yet_watching[f];
    
            started_watching++;

            cb2();
        }
    }, function _watchUnwatchedFilesDone(err) {
        var now = process.hrtime();
        var delta = hrtime.hrtimeDelta(now, then);
        var prettyDelta = hrtime.prettyHrtime(delta);
        if (started_watching > 0 || still_waiting > 0) {
            self.log.debug('FsWatcher _watchUnwatchedFiles: '
                + 'looped files: %d, started watching: %d, '
                + 'still waiting: %d, took: %s',
                not_yet_watching_keys.length,
                started_watching,
                still_waiting,
                prettyDelta);
        }

        cb();
    });
};

/*
 * Returns true if the child process is currently running and a stop() has not
 * been issued
 */
FsWatcher.prototype.isRunning = function isRunning() {
    return !this.stopping;
};

/*
 * Return the current state as an object
 */
FsWatcher.prototype.dump = function dump() {
    var self = this;

    assert.object(self.watching, 'self.watching');
    assert.object(self.not_yet_watching, 'self.not_yet_watching');

    return {
        message_delays: self.messageDelays(),
        watching: Object.keys(self.watching),
        not_yet_watching: Object.keys(self.not_yet_watching),
        running: self.isRunning()
    };
};

/*
 * Calculate the averages for the message delay buffer
 */
FsWatcher.prototype.messageDelays = function messageDelays() {
    var self = this;

    assert.object(self.message_delay_buffer, 'self.message_delay_buffer');

    var avg;
    var i;
    var o = {};
    var records = self.message_delay_buffer.records.slice(0).reverse();
    var sum;

    /*
     * Calculate delays using the last N messages where N is a number that
     * increments 10x every iteration.  i.e. this will process the averages for
     * the last 1, 10, 100, and 1000 messages averaged.
     */
    for (i = 1; i <= records.length; i *= 10) {
        sum = records.slice(0, i).reduce(function sumRecords(a, b) {
            return a + b;
        }, 0);
        avg = sum / i;
        o[i] = avg;
    }

    return o;
};

module.exports.FsWatcher = FsWatcher;

if (require.main === module) {
    var _f = process.argv[2];
    var fsw = new FsWatcher();
    fsw.on('event', function _event(ev) {
        console.log('new event: %j', ev);
    });
    fsw.watch(_f, function _watch(err) {
        if (err) {
            console.log('watch error:', err);
            return;
        }
        console.log('watching %s', _f);
    });
    var _interval = setInterval(function() {
        console.log(fsw.dump());
    }, 5000);
    setTimeout(function() {
        clearInterval(_interval);
        fsw.unwatch(_f);
        fsw.stop();
    }, 6000);
}

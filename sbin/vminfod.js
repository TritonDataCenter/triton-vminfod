#!/usr/node/bin/node --abort_on_uncaught_exception

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Vminfod starting point
 */

var bunyan = require('bunyan');
var Vminfod = require('../lib/vminfod');

var log = bunyan.createLogger({
    name: 'vminfod',
    level: 'debug',
    serializers: bunyan.stdSerializers
});

function startVminfod() {
    var opts = {
        log: log
    };
    var vminfod = new Vminfod(opts);

    log.info('Starting vminfod');

    vminfod.start(function vminfodStartDone(err) {
        if (err) {
            log.fatal({err: err}, 'Failed to start vminfod');
            process.exit(1);
        }

        log.info('Started vminfod');
    });
}

startVminfod();

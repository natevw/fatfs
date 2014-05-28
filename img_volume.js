var fs = require('fs');

exports.createDriverSync = function (path, opts) {
    opts || (opts = {});
    
    var secSize = 512,
        ro = opts.readOnly || false,
        fd = fs.openSync(path, (ro) ? 'r' : 'r+'),
        s = fs.fstatSync(fd);
    
    return {
        sectorSize: secSize,
        numSectors: s.size / secSize,
        readSector: function (n, cb) {
            fs.read(fd, Buffer(secSize), 0, secSize, n*secSize, function (e,n,d) {
                cb(e,d);
            });
        },
        writeSector: (ro) ? null : function (n, data, cb) {
            fs.write(fd, data, 0, secSize, n*secSize, function (e) {
                cb(e);
            });
        }
    };
};

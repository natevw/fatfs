var fs = require('fs');

exports.createDriverSync = function (path, opts) {
    opts || (opts = {});
    
    var ro = opts.readOnly || false,
        fd = fs.openSync(path, (ro) ? 'r' : 'r+');
    return {
        read: fs.read.bind(fs, fd),
        write: (ro) ? fs.write.bind(fs, fd) : null
    };
};

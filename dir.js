var S = require("./structs.js"),
    _ = require("./helpers.js");

var dir = exports;

dir.iterator = function (dirChain, opts) {
    opts || (opts = {});
    
    var cache = {buffer:null, n: null};
    function getSectorBuffer(n, cb) {
        if (cache.n === n) cb(null, cache.buffer);
        else cache.n = cache.buffer = null, dirChain.readSector(n, function (e,d) {
            if (e) cb(e);
            else if (!d) return cb(null, null);
            else {
                cache.n = n;
                cache.buffer = d;
                getSectorBuffer(n, cb);
            }
        });
    }
    
    var secIdx = 0,
        off = {bytes:0},
        long = null,
        _chainInfo = dirChain.toJSON();
    function getNextEntry(cb) {
        if (off.bytes >= dirChain.sectorSize) {
            secIdx += 1;
            off.bytes -= dirChain.sectorSize;
        }
        var entryPos = {chain:_chainInfo, sector:secIdx, offset:off.bytes};
        getSectorBuffer(secIdx, function (e, buf) {
            if (e) return cb(S.err.IO());
            else if (!buf) return cb(null, null, entryPos);
            
            var entryIdx = off.bytes,
                signalByte = buf[entryIdx];
            if (signalByte === S.entryDoneFlag) return cb(null, null, entryPos);
            else if (signalByte === S.entryFreeFlag) {
                off.bytes += S.dirEntry.size;
                long = null;
                if (opts.includeFree) return cb(null, {_free:true,_pos:entryPos}, entryPos);
                else return getNextEntry(cb);       // usually just skip these
            }
            
            var attrByte = buf[entryIdx+S.dirEntry.fields.Attr.offset],
                entryType = (attrByte === S.longDirFlag) ? S.longDirEntry : S.dirEntry;
            var entry = entryType.valueFromBytes(buf, off);
            entry._pos = entryPos;
//console.log("entry:", entry, secIdx, entryIdx);
            if (entryType === S.longDirEntry) {
                var firstEntry;
                if (entry.Ord & S.lastLongFlag) {
                    firstEntry = true;
                    entry.Ord &= ~S.lastLongFlag;
                    long = {
                        name: -1,
                        sum: entry.Chksum,
                        _rem: entry.Ord-1,
                        _arr: []
                    }
                }
                if (firstEntry || long && entry.Chksum === long.sum && entry.Ord === long._rem--) {
                    var S_lde_f = S.longDirEntry.fields,
                        namepart = entry.Name1;
                    if (entry.Name1.length === S_lde_f.Name1.size/2) {
                        namepart += entry.Name2;
                        if (entry.Name2.length === S_lde_f.Name2.size/2) {
                            namepart += entry.Name3;
                        }
                    }
                    long._arr.push(namepart);
                    if (!long._rem) {
                        long.name = long._arr.reverse().join('');
                        delete long._arr;
                        delete long._rem;
                    }
                } else long = null;
            } else if (!entry.Attr.volume_id) {
                var bestName = null;
                if (long && long.name) {
                    var pos = entryIdx + S.dirEntry.fields['Name'].offset,
                        sum = _.checksumName(buf, pos);
                    if (sum === long.sum) bestName = long.name;
                }
                if (!bestName) {
                    if (signalByte === S.entryIsE5Flag) entry.Name.filename = '\u00E5'+entry.Name.filename.slice(1);
                    
                    var nam = entry.Name.filename.replace(/ +$/, ''),
                        ext = entry.Name.extension.replace(/ +$/, '');
                    // TODO: lowercase bits http://en.wikipedia.org/wiki/8.3_filename#Compatibility
                    //       via NTRes, bits 0x08 and 0x10 http://www.fdos.org/kernel/fatplus.txt.1
                    bestName = (ext) ? nam+'.'+ext : nam;
                }
                entry._name = bestName;
                entry._size = entry.FileSize;
                entry._firstCluster = (entry.FstClusHI << 16) + entry.FstClusLO;
                long = null;
                return cb(null, entry, entryPos);
            } else long = null;
            getNextEntry(cb);
        });
    }
    
    function iter(cb) {
        getNextEntry(cb);
        return iter;            // TODO: previous value can't be re-used, so why make caller re-assign?
    }
    return iter;
};

function _updateEntry(entry, newStats) {
    if ('size' in newStats) entry._size = entry.FileSize = newStats.size;
    if ('archive' in newStats) entry.Attr.archive = true;           // TODO: also via newStats.mode?
    if ('mtime' in newStats) ;      // TODO
    if ('atime' in newStats) ;      // TODO
    if ('firstCluster' in newStats) {
        entry.FstClusLO = newStats.firstCluster & 0xFFFF;
        entry.FstClusHI = newStats.firstCluster >>> 16;
        entry._firstCluster = newStats.firstCluster;
    }
    return entry;
}

dir.init = function (vol, dirChain, cb) {
    var isRootDir = ('numSectors' in dirChain.toJSON()),    // HACK: all others would be a clusterChain
        initialCluster = Buffer(dirChain.sectorSize*vol._sectorsPerCluster),
        entriesOffset = {bytes:0};
    initialCluster.fill(0);
    function writeEntry(name, clusterNum) {
        while (name.length < 8) name += " ";
        S.dirEntry.bytesFromValue(_updateEntry({
            Name: {filename:name, extension:"   "},
            Attr: {directory:true}
        }, {firstCluster:clusterNum}), initialCluster, entriesOffset);
    }
    if (!isRootDir) {
        writeEntry(".", dirChain.toJSON().firstCluster);
        writeEntry("..", dirChain._parentChain.toJSON().firstCluster);
    };
    dirChain.writeToPosition(0, initialCluster, cb);
};

dir.addFile = function (vol, dirChain, name, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    var entries = [], mainEntry = null,
        short = _.shortname(name);
    entries.push(mainEntry = {
        Name: {filename:short.basis[0], extension:short.basis[1]},
        // TODO: finalize initial properties… (via `opts.mode` instead?)
        Attr: {directory:opts.dir, archive:true},
        FstClusHI: 0,
        FstClusLO: 0,
        FileSize: 0,
        _name: name,
        _size: 0
    });
    if (1 || short.lossy) {         // HACK: always write long names until short.lossy more useful!
        // name entries should be 0x0000-terminated and 0xFFFF-filled
        var S_lde_f = S.longDirEntry.fields,
            ENTRY_CHUNK_LEN = (S_lde_f.Name1.size + S_lde_f.Name2.size + S_lde_f.Name3.size)/2,
            paddedName = name,
            partialLen = paddedName.length % ENTRY_CHUNK_LEN,
            paddingNeeded = partialLen && (ENTRY_CHUNK_LEN - partialLen);
        if (paddingNeeded--) paddedName += '\u0000';
        while (paddingNeeded-- > 0) paddedName += '\uFFFF';
        // now fill in as many entries as it takes
        var off = 0,
            ord = 1;
        while (off < paddedName.length) entries.push({
            Ord: ord++,
            Name1: paddedName.slice(off, off+=S_lde_f.Name1.size/2),
            Attr: S.longDirFlag,
            Chksum: null,
            Name2: paddedName.slice(off, off+=S_lde_f.Name2.size/2),
            Name3: paddedName.slice(off, off+=S_lde_f.Name3.size/2)
        });
        entries[entries.length - 1].Ord |= S.lastLongFlag;
    }
    
    function prepareForEntries(cb) {
        var matchName = name.toUpperCase(),
            tailName = mainEntry.Name,
            maxTail = 0;
        function processNext(next) {
            next = next(function (e, d, entryPos) {
                if (e) cb(e);
                else if (!d) cb(null, {tail:maxTail, target:entryPos, lastEntry:true});
                else if (d._free) processNext(next);         // TODO: look for long enough reusable run
                else if (d._name.toUpperCase() === matchName) return cb(S.err.EXIST());
                else {
                    var dNum = 1,
                        dName = d.Name.filename,
                        dTail = dName.match(/(.*)~(\d+)/);
                    if (dTail) {
                        dNum = +dTail[2];
                        dName = dTail[1];
                    }
                    if (tailName.extension === d.Name.extension &&
                        tailName.filename.indexOf(dName) === 0)
                    {
                        maxTail = Math.max(dNum+1, maxTail);
                    }
                    processNext(next);
                }
            });
        }
        processNext(dir.iterator(dirChain, {includeFree:true}));
    }
    
    prepareForEntries(function (e, d) {
        if (e) return cb(e);
        
        if (d.tail) {
            var name = mainEntry.Name.filename,
                suffix = '~'+d.tail,
                endIdx = name.indexOf(' '),
                sufIdx = (~endIdx) ? Math.min(endIdx, name.length-suffix.length) : name.length-suffix.length;
            if (sufIdx < 0) return cb(S.err.NAMETOOLONG());         // TODO: would EXIST be more correct?
            mainEntry.Name.filename = name.slice(0,sufIdx)+suffix+name.slice(sufIdx+suffix.length);
//console.log("Shortname amended to:", mainEntry.Name);
        }
        
        vol.allocateInFAT(dirChain.toJSON().firstCluster || 2, function (e,fileCluster) {
            if (e) return cb(e);
            
            var nameBuf = S.dirEntry.fields['Name'].bytesFromValue(mainEntry.Name),
                nameSum = _.checksumName(nameBuf);
            _updateEntry(mainEntry, {firstCluster:fileCluster});
            mainEntry._pos = _.adjustedPos(d.target, S.dirEntry.size*(entries.length-1));
            entries.slice(1).forEach(function (entry) {
                entry.Chksum = nameSum;
            });
            entries.reverse();
            if (d.lastEntry) entries.push({});
            
            var entriesData = new Buffer(S.dirEntry.size*entries.length),
                dataOffset = {bytes:0};
            entries.forEach(function (entry) {
                var entryType = ('Ord' in entry) ? S.longDirEntry : S.dirEntry;
                entryType.bytesFromValue(entry, entriesData, dataOffset);
            });
            
//console.log("Writing", entriesData.length, "byte directory entry", mainEntry, "into", dirChain.toJSON(), "at", d.target);
            dirChain.writeToPosition(d.target, entriesData, function (e) {
                // TODO: if we get error, what/should we clean up?
                if (e) cb(e);
                else cb(null, mainEntry, vol.chainForCluster(fileCluster, dirChain));
            });
        });
    });
};

dir._findInDirectory = function (vol, dirChain, name, cb) {
    name = name.toUpperCase();
    function processNext(next) {
        next = next(function (e, d) {
            if (e) cb(e);
            else if (!d) cb(S.err.NOENT());
            else if (d._name.toUpperCase() === name) return cb(null, d);
            else processNext(next);
        });
    }
    processNext(dir.iterator(dirChain));
};

dir.entryForPath = function (vol, path, cb) {
    var spets = _.absoluteSteps(path).reverse();
    function findNext(chain) {
        var name = spets.pop();
//console.log("Looking in", chain, "for:", name);
        if (!name) cb(null, {
            // TODO: *real* fake entry for root directory
            Attr: {directory:true}, FileSize: 0
        }, chain);
        else dir._findInDirectory(vol, chain, name, function (e,entry) {
            if (e) cb(e, (spets.length) ? null : {_missingFile:name}, chain);
            else {
                var _chain = vol.chainForCluster(entry._firstCluster);
                if (spets.length) {
                    if (entry.Attr.directory) findNext(_chain);
                    else cb(S.err.NOTDIR());
                }
                else cb(null, entry, _chain);
            }
        });
    }
    findNext(vol.rootDirectoryChain);
};

dir.updateEntry = function (vol, entry, newStats, cb) {
    if (!entry._pos || !entry._pos.chain) throw Error("Entry source unknown!");
    
    var entryPos = entry._pos,
        chain = vol.chainFromJSON(entryPos.chain),          // TODO: fix
        newEntry = _updateEntry(entry, newStats),
        data = S.dirEntry.bytesFromValue(newEntry);
//console.log("UPDATING ENTRY", newStats, newEntry, entryPos, data);
    // TODO: if write fails, then entry becomes corrupt!
    chain.writeToPosition(entryPos, data, cb);
};

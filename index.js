var S = require("./structs.js"),
    _ = require("./helpers.js");

exports.createFileSystem = function (volume) {

    // TODO: how will operations be made consistent? (e.g. conflicting modifications to FAT12 entries, etc.)


    var fs = {};
    
    var sectorBuffer;               // TODO: get rid of this global (must be used/copied by cb before returning)
    function setSectorSize(len) {
        if (!sectorBuffer || sectorBuffer.length !== len) sectorBuffer = new Buffer(len);
    }
    function getSectorSize() {
        return sectorBuffer.length;
    }
    function readSector(secNum, cb) {
        var secSize = getSectorSize();
        volume.read(sectorBuffer, 0, secSize, secNum*secSize, function (e) {
            cb(e, sectorBuffer);
        });
    }
    function writeSector(secNum, data, cb) {
console.log("Writing sector", secNum, data, data.length);
        var secSize = getSectorSize();
        // NOTE: these are internal assertions, public API will get proper `S.err`s
        if (data.length !== secSize) throw Error("Must write complete sector");
        else if (!volume.write) throw Error("Read-only filesystem");
        else volume.write(data, 0, secSize, secNum*secSize, cb);
    }
    
    // TODO: when/where to do this stuff? do we need a 'ready' event… :-(
    setSectorSize(512);
    readSector(0, function (e) {
        if (e) throw e;
        
        if (sectorBuffer[510] !== 0x55 || sectorBuffer[511] !== 0xAA) throw Error("Invalid volume signature!");
        var isFAT16 = sectorBuffer.readUInt16LE(22),        // HACK: get FATSz16 without full decode
            bootStruct = (isFAT16) ? S.boot16 : S.boot32;
        var D = bootStruct.valueFromBytes(sectorBuffer);
        if (!D.BytsPerSec) throw Error("This looks like an ExFAT volume! (unsupported)");
        setSectorSize(D.BytsPerSec);
        
//console.log(d);
        
        var FATSz = (isFAT16) ? D.FATSz16 : D.FATSz32,
            rootDirSectors = Math.ceil((D.RootEntCnt * 32) / D.BytsPerSec),
            firstDataSector = D.ResvdSecCnt + (D.NumFATs * FATSz) + rootDirSectors,
            totSec = (D.TotSec16) ? D.TotSec16 : D.TotSec32,
            dataSec = totSec - firstDataSector,
            countofClusters = Math.floor(dataSec / D.SecPerClus);
        
        var fatType;
        if (countofClusters < 4085) {
            fatType = 'fat12';
        } else if (countofClusters < 65525) {
            fatType = 'fat16';
        } else {
            fatType = 'fat32';
        }
        
        // TODO: abort if (TotSec16/32 > DskSz) to e.g. avoid corrupting subsequent partitions!
        
//console.log("rootDirSectors", rootDirSectors, "firstDataSector", firstDataSector, "countofClusters", countofClusters, "=>", fatType);
        
        function firstSectorOfCluster(n) {
            return firstDataSector + (n-2)*D.SecPerClus;
        }
        
        
        // TODO: all this FAT manipulation is crazy inefficient! needs read caching *and* write caching
        // NOTE: the best place for cache might be in `volume` handler, though. add a `sync` method to that spec?
        
        // TODO: how should we handle redundant FATs? mirror every write? just ignore completely? copy-on-eject? (how do other OSes handle?)
        
        
        var fatChain = openSectorChain(D.ResvdSecCnt, FATSz);
        
        
        function fatInfoForCluster(n) {
            var entryStruct = S.fatField[fatType],
                FATOffset = (fatType === 'fat12') ? Math.floor(n/2) * entryStruct.size : n * entryStruct.size,
                SecNum = D.ResvdSecCnt + Math.floor(FATOffset / D.BytsPerSec);
                EntOffset = FATOffset % D.BytsPerSec;
            return {sector:SecNum, offset:EntOffset, struct:entryStruct};
        }
        
        function fetchFromFAT(clusterNum, cb) {
            var info = fatInfoForCluster(clusterNum);
            readFromChain(fatChain, info, info.struct.size, function (e,n,d) {
                if (e) return cb(e);
                var status = info.struct.valueFromBytes(d), prefix;
                if (fatType === 'fat12') {
                    if (clusterNum % 2) {
                        status = (status.field0a << 8) + status.field0bc;
                    } else {
                        status = (status.field1ab << 4) + status.field1c;
                    }
                }
                else if (fatType === 'fat32') {
                    status &= 0x0FFFFFFF;
                }
                
                var prefix = S.fatPrefix[fatType];
                if (status === S.fatStat.free) cb(null, 'free');
                else if (status === S.fatStat._undef) cb(null, '-invalid-');
                else if (status > prefix+S.fatStat.eofMin) cb(null, 'eof');
                else if (status === prefix+S.fatStat.bad) cb(null, 'bad');
                else if (status > prefix+S.fatStat.rsvMin) cb(null, 'reserved');
                else cb(null, status);
            });
        }
        
        function storeToFAT(clusterNum, status, cb) {
            if (typeof status === 'string') {
                status = S.fatStat[status];
                status += S.fatPrefix[fatType];
            }
            var info = fatInfoForCluster(clusterNum);
            
            
            
            if (fatType === 'fat12') readFromChain(fatChain, info, info.struct.size, function (e,n,d) {
                var value = info.struct.valueFromBytes(d);
                if (clusterNum % 2) {
                    value.field0a = status >>> 8;
                    value.field0bc = status & 0xFF;
                } else {
                    value.field1ab = status >>> 4;
                    value.field1c = status & 0x0F;
                }
                var entry = info.struct.bytesFromValue(value);
                writeToChain(fatChain, info, entry, cb);
                
            }); else {
                var entry = info.struct.bytesFromValue(status);
                writeToChain(fatChain, info, entry, cb);
            }
        }
        
        function allocateInFAT(hint, cb) {
            if (typeof hint === 'function') {
                cb = hint;
                hint = 2;   // TODO: cache a better starting point?
            }
            function searchForFreeCluster(num, cb) {
                if (num < countofClusters) fetchFromFAT(num, function (e, status) {
                    if (e) cb(e);
                    else if (status === 'free') cb(null, num);
                    else searchForFreeCluster(num+1, cb);
                }); else cb(S.err.NOSPC());     // TODO: try searching backwards from hint…
            }
            searchForFreeCluster(hint, function (e, clusterNum) {
                if (e) cb(e);
                else storeToFAT(clusterNum, 'eof', cb);
            });
        }
        
        // TODO: return an actual `instanceof fs.Stat` somehow?
        function makeStat(dirEntry) {
            var stats = {},
                _ = {};
            
            stats._ = function (k) {
                return _[k];
            }
            _.entry = dirEntry,
            _.firstCluster = (dirEntry.FstClusHI << 16) + dirEntry.FstClusLO;;
            
            
            stats.isFile = function () {
                return (!dirEntry.Attr.volume_id && !dirEntry.Attr.directory);
            };
            stats.isDirectory = function () {
                return dirEntry.Attr.directory;
            };
            // TODO: are these all correct? (especially block/char)
            stats.isBlockDevice = function () { return true; }
            stats.isCharacterDevice = function () { return false; }
            stats.isSymbolicLink = function () { return false; }
            stats.isFIFO = function () { return false; }
            stats.isSocket = function () { return false; }
            stats.size = dirEntry.FileSize;
            stats.blksize = D.SecPerClus*D.BytsPerSec;
            
            // TODO: more infos!
            // …
            stats.blocks;
            stats.atime;
            stats.mtime;
            stats.ctime;
            return stats;
        }
        
        function updateEntry(dirEntry, newStats, cb) {
            if (!dirEntry._pos || !dirEntry._pos.chain) throw Error("Entry source unknown!");
            
            var entryPos = dirEntry._pos,
                chain = chainFromJSON(entryPos.chain),
                newEntry = Object.create(dirEntry);
            if ('size' in newStats) newEntry.FileSize = newStats.size;
            if ('archive' in newStats) newEntry.Attr.archive = true;
            if ('mtime' in newStats) ;      // TODO
            if ('atime' in newStats) ;      // TODO
            
            var data = S.dirEntry.bytesFromValue(newEntry);
            writeToChain(chain, entryPos, data, cb);
        }
        
        function findInDirectory(dirChain, name, cb) {
            name = name.toUpperCase();
            function processNext(next) {
                next = next(function (e, d) {
                    if (e) cb(e);
                    else if (!d) cb(S.err.NOENT());
                    else if (d._name.toUpperCase() === name) return cb(null, makeStat(d));
                    else processNext(next);
                });
            }
            processNext(directoryIterator(dirChain));
        }
        
        function directoryIterator(dirChain, opts) {
            opts || (opts = {});
            var _cachedBuf = null;
            function getSectorBuffer(n, cb) {
                if (_cachedBuf && n === _cachedBuf._n) cb(null, _cachedBuf);
                else _cachedBuf = null, dirChain.readSector(n, function (e,d) {
                    if (e) cb(e);
                    else {
                        d._n = n;
                        _cachedBuf = d;
                        getSectorBuffer(n, cb);
                    }
                });
            }
            
            var secIdx = 0,
                off = {bytes:0},
                long = null,
                _chainInfo = dirChain.toJSON();
            function getNextEntry(cb) {
                if (off.bytes >= getSectorSize()) {
                    secIdx += 1;
                    off.bytes -= getSectorSize();
                }
                var entryPos = {chain:_chainInfo, sector:secIdx, offset:off.bytes};
                getSectorBuffer(secIdx, function (e, sectorBuffer) {
                    if (e) return cb(S.err.IO());
                    else if (!sectorBuffer) return cb(null, null, entryPos);
                    
                    var entryIdx = off.bytes,
                        signalByte = sectorBuffer[entryIdx];
                    if (signalByte === S.entryDoneFlag) return cb(null, null, entryPos);
                    else if (signalByte === S.entryFreeFlag) {
                        off.bytes += S.dirEntry.size;
                        long = null;
                        if (opts.includeFree) return cb(null, {_free:true,_pos:entryPos}, entryPos);
                        else return getNextEntry(cb);       // usually just skip these
                    }
                    
                    var attrByte = sectorBuffer[entryIdx+S.dirEntry.fields.Attr.offset],
                        entryType = (attrByte === S.longDirFlag) ? S.longDirEntry : S.dirEntry;
                    var entry = entryType.valueFromBytes(sectorBuffer, off);
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
                                sum = _.checksumName(sectorBuffer, pos);
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
        }
        
        // NOTE: used [with mixed feelings] by chains, broken out to mark uses
        function _pastEOF(cb) { _.delayedCall(cb, null, null); }
        
        function openSectorChain(firstSector, numSectors) {
            var chain = {_dbgSector:firstSector};
            
            chain.readSector = function (i, cb) {
                var s = firstDataSector - rootDirSectors;
                if (i < rootDirSectors) readSector(s+i, cb);
                else _pastEOF(cb);
            };
            
            chain.toJSON = function () {
                return {firstSector:firstSector, numSectors:numSectors};
            };
            
            return chain;
        }
        
        function openClusterChain(firstCluster, opts) {
            var chain = {_dbgCluster:firstCluster},
                cache = [firstCluster];
            
            function _cacheIsComplete() {
                return cache[cache.length-1] === 'eof';
            }
            
            function extendCacheToInclude(i, cb) {          // NOTE: may `cb()` before returning!
                if (i < cache.length) cb(null, cache[i]);
                else if (_cacheIsComplete()) cb(null, 'eof');
                else fetchFromFAT(cache[cache.length-1], function (e,d) {
                    if (e) cb(e);
                    else if (typeof d === 'string' && d !== 'eof') cb(S.err.IO());
                    else {
                        cache.push(d);
                        extendCacheToInclude(i, cb);
                    }
                });
            }
            
            // NOTE: returns the final cluster (same as if called `extendCacheToInclude(len)`)
            function expandChainToLength(len, cb) {
                if (!_cacheIsComplete()) throw Error("Must be called only when cache is complete!");
                else cache.pop();            // remove 'eof' entry until finished
                
                function addCluster(clustersNeeded, lastCluster) {
                    allocateInFAT(lastCluster, function (e, newCluster) {
                        if (e) cb(e);
                        else storeToFAT(lastCluster, newCluster, function (e) {
                            if (e) return cb(e);
                            
                            cache.push(newCluster);
                            if (clustersNeeded) {
                                // TODO: zero-fill contents of newCluster!
                                addCluster(clustersNeeded-1, newCluster);
                            } else {
                                // NOTE: we don't zero-fill last cluster; we assume it will be written next
                                cache.push('eof');
                                cb(null, newCluster);
                            }
                        });
                    });
                }
                addCluster(len - cache.length, cache[cache.length - 1]);
            }
            
            function firstSectorOfClusterAtIdx(i, alloc, cb) {
                extendCacheToInclude(i, function (e,c) {
                    if (e) cb(e);
                    else if (c === 'eof') {
                        if (alloc) expandChainToCluster(i, function (e,c) {
                            if (e) cb(e);
                            else cb(null, firstSectorOfCluster(c));
                        });
                        else cb(null, null);
                    }
                    else cb(null, firstSectorOfCluster(c));
                });
            }
            
            chain.readSector = function (i, cb) {
                var o = i % D.SecPerClus,
                    c = (i - o) / D.SecPerClus;
                firstSectorOfClusterAtIdx(c, false, function (e,s) {
                    if (e) cb(e);
                    else if (s) readSector(s+o, cb);
                    else _pastEOF(cb);
                });
            };
            
            chain.writeSector = function (i, data, cb) {
                var o = i % D.SecPerClus,
                    c = (i - o) / D.SecPerClus;
                firstSectorOfClusterAtIdx(c, true, function (e,s) {
                    if (e) cb(e);
                    else writeSector(s+o, data, cb);
                });
            };
            
            //chain.truncate
            
            chain.toJSON = function () {
                return {firstCluster:firstCluster};
            };
            
            return chain;
        }
        
        function chainFromJSON(d) {
            return ('numSectors' in d) ?
                openSectorChain(d.firstSector, d.numSectors) :
                openClusterChain(d.firstCluster);
        }
        
        function posFromOffset(off) {
            var secSize = getSectorSize(),
                offset = off % secSize,
                sector = (off - offset) / secSize;
            return {sector:sector, offset:offset};
        }
        
        function adjustedPos(pos, bytes) {
            var _pos = {
                chain: pos.chain,
                sector: pos.sector,
                offset: pos.offset
            }, secSize = getSectorSize();
            while (_pos.offset > secSize) {
                _pos.sector += 1;
                _pos.offset -= secSize;
            }
            return _pos;
        }
        
        
        function readFromChain(chain, targetPos, buffer, cb) {
            if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
            if (typeof buffer === 'number') buffer = new Buffer(buffer);
            function _readFromChain(sec, off, bufPos) {
                chain.readSector(sec, function (e, secData) {
                    if (e) return cb(e);
                    else if (!secData) return cb(null, bufPos, buffer);
                    
                    var len = secData.length - off;
                    secData.copy(buffer, bufPos, off, off+len);
                    bufPos += len;
                    if (bufPos < buffer.length) _readFromChain(sec+1, 0, bufPos);
                    else cb(null, buffer.length, buffer);
                });
            }
            _readFromChain(targetPos.sector, targetPos.offset, 0);
        }
        
        // TODO: should writeToChain give a partial `bytesWritten` in case of error?
        function writeToChain(chain, targetPos, data, cb) {
            if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
            function _writeToChain(sec, off, data) {
                var incomplete = (off || data.length < getSectorSize());
                if (incomplete) chain.readSector(sec, function (e, orig) {
                    if (e) return cb(e);
                    else if (!orig) {
                        orig = new Buffer(getSectorSize());
                        orig.fill(0);
                    }
                    data.copy(orig, off);
                    data = data.slice(getSectorSize() - off);
                    chain.writeSector(sec, orig, function (e) {
                        if (e) cb(e);
                        else if (data.length) _writeToChain(sec+1, 0, data);
                        else cb(null);
                    });
                }); else chain.writeSector(sec, data, function (e) {
                    if (e) return cb(e);
                    
                    data = data.slice(getSectorSize());
                    if (data.length) _writeToChain(sec+1, 0, data);
                    else cb(null);
                });
            }
            _writeToChain(targetPos.sector, targetPos.offset, data);
        }
        
        
        function addFile(dirChain, name, cb) {
            var entries = [], mainEntry = null,
                short = _.shortname(name);
            entries.push(mainEntry = {
                Name: {filename:short.basis[0], extension:short.basis[1]},
                // TODO: finalize initial properties…
                Attr: {directory:false},
                FstClusHI: 0,
                FstClusLO: 0,
                FileSize: 0,
                _name: name
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
                        else if (!d) cb(null, {tail:maxTail+1, target:entryPos, lastEntry:true});
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
                                maxTail = Math.max(dNum, maxTail);
                            }
                            processNext(next);
                        }
                    });
                }
                processNext(directoryIterator(dirChain, {includeFree:true}));
            }
            
            prepareForEntries(function (e, d) {
                if (e) return cb(e);
                
                if (d.tail) {
                    var name = mainEntry.Name.filename,
                        suffix = '~'+d.tail,
                        sufIdx = Math.min(name.indexOf(' '), name.length-suffix.length);
                    if (sufIdx < 0) return cb(S.err.NAMETOOLONG());         // TODO: would EXIST be more correct?
                    mainEntry.Name.filename = name.slice(0,sufIdx)+suffix+name.slice(sufIdx+suffix.length);
                    console.log("Shortname amended to:", mainEntry.Name);
                }
                
                // TODO: provide dirChain's cluster as hint
                allocateInFAT(function (e,fileCluster) {
                    if (e) return cb(e);
                    
                    var nameBuf = S.dirEntry.fields['Name'].bytesFromValue(mainEntry.Name),
                        nameSum = _.checksumName(nameBuf);
                    mainEntry.FstClusLO = fileCluster & 0xFFFF;
                    mainEntry.FstClusHI = fileCluster >>> 16;
                    mainEntry._pos = adjustedPos(d.target, S.dirEntry.size*(entries.length-1));
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
                    
                    console.log("Writing", entriesData.length, "byte directory entry", d.target, "bytes into", dirChain);
                    writeToChain(dirChain, d.target, entriesData, function (e) {
                        // TODO: if we get error, what/should we clean up?
                        if (e) cb(e);
                        else cb(null, makeStat(mainEntry), openClusterChain(fileCluster));
                    });
                });
            });
        }
        
        function entryForPath(path, cb) {
            var spets = _.absoluteSteps(path).reverse();
            function findNext(chain) {
                var name = spets.pop();
console.log("Looking in", chain, "for:", name);
                findInDirectory(chain, name, function (e,stats) {
                    if (e) cb(e, (spets.length) ? null : {_missingFile:name}, chain);
                    else {
                        var _chain = openClusterChain(stats._('firstCluster'));
                        if (spets.length) {
                            if (stats.isDirectory()) findNext(_chain);
                            else cb(S.err.NOTDIR());
                        }
                        else cb(null, stats, _chain);
                    }
                });
            }
            var chain = (isFAT16) ?
                openSectorChain(firstDataSector - rootDirSectors, rootDirSectors) :
                openClusterChain(D.RootClus);
            findNext(chain);
        }
        
        fs._entryForPath = entryForPath;
        fs._updateEntry = updateEntry;
        fs._writeToChain = writeToChain;
        fs._readFromChain = readFromChain;
        fs._addFile = addFile;
    });
    
    
    // NOTE: we really don't share namespace, but avoid first three anyway…
    var fileDescriptors = [null,null,null];
    
    fs.open = function (path, flags, mode, cb) {
        if (typeof mode === 'function') {
            cb = mode;
            mode = 0666;
        }
        
        var _fd = {flags:null,stats:null,chain:null,pos:0},
            f = _.parseFlags(flags);
        if (!volume.write && (f.write || f.create || f.truncate)) return _.delayedCall(cb, S.err.ROFS());
        else _fd.flags = f;
        
        fs._entryForPath(path, function (e,stats,chain) {
            if (e && !(e.code === 'NOENT' && f.create && stats)) cb(e);
            else if (e) fs._addFile(chain, stats._missingFile, function (e,newStats,newChain) {
                if (e) cb(e);
                else finish(newStats, newChain);
            });
            else finish(stats,chain);
            function finish(fileStats,fileChain) {
                _fd.stats = fileStats;
                _fd.chain = fileChain;
                if (f.truncate && _fd.stats.size) {
                    // TODO: set size of file to zero…
                    cb(S.err._TODO());
                }
                // TODO: handle ISDIR/ACCES situations
                else cb(null, fileDescriptors.push(_fd)-1);
            }
        });
    };
    
    fs.fstat = function (fd, cb) {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else _.delayedCall(cb, null, _fd.stats);
    };
    
    fs.read = function (fd, buf, off, len, pos, cb) {
        var _fd = fileDescriptors[fd];
        if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());
        
        var _pos = (pos === null) ? _fd.pos : pos,
            _buf = buf.slice(off,off+len);
        fs._readFromChain(_fd.chain, _pos, _buf, function (e,bytes,slice) {
            if (_.workaroundTessel380) _buf.copy(buf,off);        // WORKAROUND: https://github.com/tessel/beta/issues/380
            _fd.pos = _pos + bytes;
            if (e || volume.noatime) finish(e);
            else fs._updateEntry(_fd.stats._('entry'), {atime:new Date()}, finish);
            function finish(e) {
                cb(e,bytes,buf);
            }
        });
    };
    
    fs.write = function(fd, buf, off, len, pos, cb) {
        var _fd = fileDescriptors[fd];
        if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
        
        var _pos = (pos === null) ? _fd.pos : pos,
            _buf = buf.slice(off,off+len);
        fs._writeToChain(_fd.chain, _pos, _buf, function (e) {
            _fd.pos = _pos + len;
            var curDate = new Date(),
                newSize = Math.max(_fd.stats.size, _fd.pos),
                newInfo = {size:newSize,archive:true,atime:curDate,mtime:curDate};
            // TODO: figure out why this silently fails on FAT12
            fs._updateEntry(_fd.stats._('entry'), newInfo, function (ee) {
                cb(e||ee, len, buf);
            });
        });
    }
    
    fs.close = function (fd, cb) {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else _.delayedCall(cb, fileDescriptors[fd] = null);
    };
    
    
    function _fdOperation(path, opts, fn, cb) {
        fs.open(path, opts.flag, function (e,fd) {
            if (e) cb(e);
            else fn(fd, function () {
                var ctx = this, args = arguments;
                fs.close(fd, function (closeErr) {
                    cb.apply(this, args);
                });
            });
        });
    }
    
    fs.stat = fs.lstat = function (path, cb) {
        _fdOperation(path, {flag:'r'}, function (fd, cb) {
            fs.fstat(fd, cb);
        }, cb);
    };
    
    fs.readFile = function (path, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = 'r');
        _fdOperation(path, opts, function (fd, cb) {
            fs.fstat(fd, function (e,stat) {
                if (e) return cb(e);
                else {
                    var buffer = new Buffer(stat.size);
                    fs.read(fd, buffer, 0, buffer.length, null, function (e) {
                        if (e) cb(e);
                        else cb(null, (opts.encoding) ? buffer.toString(opts.encoding) : buffer);
                    });
                }
            });
        }, cb);
    };
    
    fs.writeFile = function (path, data, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = 'w');
        _fdOperation(path, opts, function (fd, cb) {
            if (typeof data === 'string') data = new Buffer(data, opts.encoding || 'utf8');
            fs.write(fd, data, 0, data.length, null, function (e) { cb(e); });
        }, cb);
    };
    
    
    return fs;
}
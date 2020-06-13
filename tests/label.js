// import fatfsBuffer, { init as fatfsBufferInit } from './fatfs-buffer'
const promisifyAll = require('promise-toolbox').promisifyAll;
var fatfs = require("../");
const { fatStat } = require('../structs');
var fatfsBuffer = require('./fatfs-buffer').buffer
var fatfsBufferInit = require('./fatfs-buffer').init
var fs = require('fs')

const buffer = fatfsBufferInit({ label: 'cidata     ' })

const { createLabel } = promisifyAll(
  fatfs.createFileSystem(fatfsBuffer(buffer), {allowLowercaseNames: true})
)

createLabel("cidata").then(() => {
  fs.writeFileSync("tests/label.img", buffer)
})
/*    Copyright 2016 Rottiesoft LLC 
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';
var log;
var os = require('os');
var network = require('network');

var redis = require("redis");
var rclient = redis.createClient();

var SysManager = require('../net2/SysManager.js');
var sysManager = new SysManager('info');

var FlowManager = require('../net2/FlowManager.js');
var flowManager = new FlowManager('info');

rclient.on("error", function (err) {
    console.log("Redis(alarm) Error " + err);
});

var async = require('async');
var instance = null;
var HostManager = require("../net2/HostManager.js");
var hostManager = new HostManager("cli", 'client', 'debug');

var AppManager = require('../net2/AppManager.js');
var appManager = new AppManager('../net2/appSignature.json', 'debug');

var stddev_limit = 8;
var AlarmManager = require('../net2/AlarmManager.js');
var alarmManager = new AlarmManager('debug');

module.exports = class FlowMonitor {
    constructor(timeslice, monitorTime, loglevel) {
        this.timeslice = timeslice; // in seconds
        this.monitorTime = monitorTime;

        if (instance == null) {
            let c = require('../net2/MessageBus.js');
            this.publisher = new c(loglevel);

            instance = this;
            log = require("../net2/logger.js")("FlowMonitor", loglevel);
        }
        return instance;
    }


    flowIntel(flows) {
        log.info("FLOWWWWWWWWWWWWWWW INTEL",flows.length);
        for (let i in flows) {
            let flow = flows[i];
            log.info("FLOW:INTEL:PROCESSING",flow);
            if (flow['intel'] && flow['intel']['c']) {
                log.info("########## flowIntel",flow);
                let c = flow['intel']['c'];
                if (c == "av") {
                    let msg = "Watching video "+flow["shname"] +" "+flow["dhname"];
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    alarmManager.alarm(flow.sh, "warn", 'minor', '0', {"msg":msg}, null, null);
                } else if (c=="porn") {
                    let msg = "Watching Porn "+flow["shname"] +" "+flow["dhname"];
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    let actionobj = {
                        title: "Questionable Action",
                        actions: ["block","ignore"],
                        src: flow.sh,
                        dst: flow.dh,
                        target: flow.lhost,
                        msg: msg
                    };
                    alarmManager.alarm(flow.sh, "warn", 'minor', '0', {"msg":msg}, actionobj, null);
                } else if (c=="intel") {
                    // Intel object
                    //     {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
    //.indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
                    let msg = "Watching Intel "+flow["shname"] +" "+flow["dhname"];
                    let intelobj = null;
                    if (flow.fd == "in") {
                        intelobj = {
                            ts: flow.ts,
                            "id.orig_h": flow.sh,
                            "id.resp_h": flow.dh,
                            "seen.indicator_type":"Intel::DOMAIN", 
                        };
                        if (flow.dhname) {
                            intelobj['seen.indicator'] = flow.dhname;
                        } else {
                            intelobj['seen.indicator'] = flow.dh;
                        }
                    } else {
                        intelobj = {
                            ts: flow.ts,
                            "id.orig_h": flow.dh,
                            "id.resp_h": flow.sh,
                            "seen.indicator_type":"Intel::DOMAIN", 
                        };
                        if (flow.shname) {
                            intelobj['seen.indicator'] = flow.shname;
                        } else {
                            intelobj['seen.indicator'] = flow.sh;
                        }
                    }

                    if (flow.pf) {
                        for (let o in flow.pf) {
                             intelobj['id.resp_p'] = o;
                             break;
                        }
                    }

                    log.debug("Intel:Flow Sending Intel", intelobj);
                  
                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.orig_h'], intelobj);
                    this.publisher.publish("DiscoveryEvent", "Intel:Detected", intelobj['id.resp_h'], intelobj);

                    /*
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    alarmManager.alarm(flow.sh, "warn", 'major', '50', {"msg":msg}, null, null);
                    */
                } else {
                    let msg = "Doing "+c+" "+flow["shname"] +" "+flow["dhname"];
                    this.publisher.publish("DiscoveryEvent", "Notice:Detected", flow.sh, {
                                            msg:msg
                                        });
                    alarmManager.alarm(flow.sh, "warn", 'major', '50', {"msg":msg}, null, null);
                }
            } 
        }
    }

    // summarize will 
    // neighbor:<mac>:ip:
    //  {ip: { 
    //      ts: ..
    //      count: ...
    //  }
    //  {host: ...}
    // neighbor:<mac>:host:
    //   {set: host}
    summarizeNeighbors(host,flows,direction) {
        let key = "neighbor:"+host.o.mac;
        log.info("Summarizing Neighbors ",flows.length,key);


        rclient.hgetall(key,(err,data)=> {
             let neighborArray = [];
             if (data == null) {
                 data = {};
             } else {
                 for (let n in data) {
                     data[n] = JSON.parse(data[n]);
                     data[n].neighbor = n;
                     neighborArray.push(data[n]);
                 }
             }
             let now = Date.now()/1000;
             for (let f in flows) {
                 let flow = flows[f];
                 let neighbor = flow.dh;
                 let ob = flow.ob;
                 let rb = flow.rb;
                 let du = flow.du;
                 let name = flow.dhname;
                 if (flow.lh == flow.dh) {
                     neighbor = flow.sh;
                     ob = flow.rb;
                     rb = flow.ob;
                     name = flow.shname;
                 }
                 if (data[neighbor]!=null) {
                     data[neighbor]['ts'] = now;
                     data[neighbor]['count'] +=1;
                     data[neighbor]['rb'] +=rb; 
                     data[neighbor]['ob'] +=ob; 
                     data[neighbor]['du'] +=du;
                     data[neighbor]['neighbor']=neighbor;
                 } else {
                     data[neighbor] = {};
                     data[neighbor]['neighbor']=neighbor;
                     data[neighbor]['cts'] = now;
                     data[neighbor]['ts'] = now;
                     data[neighbor]['count'] =1;
                     data[neighbor]['rb'] =rb; 
                     data[neighbor]['ob'] =ob; 
                     data[neighbor]['du'] =du; 
                     neighborArray.push(data[neighbor]);
                 }
                 if (name) {
                     data[neighbor]['name'] = name;
                 }
             }
             let savedData = {};
 
             //chop the minor ones
             neighborArray.sort(function (a, b) {
                return Number(b.count) - Number(a.count);
             })
             let max = 20;
             
             let deletedArrayCount = neighborArray.slice(max+1);
             let neighborArrayCount = neighborArray.slice(0,max);

             neighborArray.sort(function (a, b) {
                return Number(b.ts) - Number(a.ts);
             })

             let deletedArrayTs = neighborArray.slice(max+1);
             let neighborArrayTs = neighborArray.slice(0,max);

             deletedArrayCount = deletedArrayCount.filter((val)=>{
                 return neighborArrayTs.indexOf(val) == -1;
             });
             deletedArrayTs = deletedArrayTs.filter((val)=>{
                 return neighborArrayCount.indexOf(val) == -1;
             });
             
             let deletedArray = deletedArrayCount.concat(deletedArrayTs);

             log.debug("Neighbor:Summary:Deleted", deletedArray,{});
             
             let addedArray = neighborArrayCount.concat(neighborArrayTs);

             log.debug("Neighbor:Summary",key, deletedArray.length, addedArray.length, deletedArrayTs.length, neighborArrayTs.length,deletedArrayCount.length, neighborArrayCount.length);
        
             for (let i in deletedArray) {
                 rclient.hdel(key,deletedArray[i].neighbor);
             }

             for (let i in addedArray) { 
                 // need to delete things not here
                 savedData[addedArray[i].neighbor] = addedArray[i];
             }

             for (let i in savedData) {
                 savedData[i] = JSON.stringify(data[i]);
             }
             rclient.hmset(key,savedData,(err,d)=>{
                 log.info("Set Host Summary",key,savedData,d);
             });
        });
    }

    detect(listip, period,host,callback) {
        let end = Date.now() / 1000;
        let start = end - period; // in seconds
        flowManager.summarizeConnections(listip, "in", end, start, "time", this.monitorTime, true, (err, result) => {
            this.flowIntel(result);
            this.summarizeNeighbors(host,result,'in');
            flowManager.summarizeConnections(listip, "out", end, start, "time", this.monitorTime, true, (err, result) => {
                this.flowIntel(result);
                this.summarizeNeighbors(host,result,'out');
            });
        });
    }


    flows(listip, period, callback) {
        let end = Date.now() / 1000;
        let start = end - this.monitorTime; // in seconds
        flowManager.summarizeConnections(listip, "in", end, start, "time", this.monitorTime, true, (err, result) => {
            //this.flowIntel(result);
            let inSpec = flowManager.getFlowCharacteristics(result, "in", 1000000, stddev_limit);
            flowManager.summarizeConnections(listip, "out", end, start, "time", this.monitorTime, true, (err, resultout) => {
                let outSpec = flowManager.getFlowCharacteristics(resultout, "out", 500000, stddev_limit);
                callback(null, inSpec, outSpec);
            });
        });
    }

    //
    // monitor:flow:ip:<>: <ts score> / { notification }
    //

    // callback doesn't work for now
    // this will callback with each flow that's valid 

    saveSpecFlow(direction, ip, flow, callback) {
        let key = "monitor:flow:" + direction + ":" + ip;
        let strdata = JSON.stringify(flow);
        let redisObj = [key, flow.nts, strdata];
        log.debug("monitor:flow:save", redisObj);
        rclient.zadd(redisObj, (err, response) => {
            if (err) {
                log.error("monitor:flow:save", key, err);
            }
            if (callback) {
                callback(err, null);
            }
        });
    }

    processSpec(direction, flows, callback) {
        for (let i in flows) {
            let flow = flows[i];
            flow.rank = i;
            let ip = flow.sh;
            if (direction == 'out') {
                ip = flow.dh;
            }
            let key = "monitor:flow:" + direction + ":" + ip;
            let fullkey = "monitor:flow:" + direction + ":" + flow.sh + ":" + flow.dh;
            log.debug("monitor:flow", key);
            let now = Date.now() / 1000;
            rclient.zrevrangebyscore([key, now, now - 60 * 60 * 8], (err, results) => {
                if (err == null && results.length > 0) {
                    log.debug("monitor:flow:found", results);
                    let found = false;
                    for (let i in results) {
                        let _flow = JSON.parse(results[i]);
                        if (_flow.sh == flow.sh && _flow.dh == flow.dh) {
                            found = true;
                            break;
                        }
                    }
                    if (this.fcache[fullkey] != null) {
                        found = true;
                    }

                    //found = false;

                    if (found == false) {
                        flow.nts = Date.now() / 1000;
                        this.fcache[fullkey] = flow;
                        this.saveSpecFlow(direction, ip, flow, (err) => {
                            callback(null, direction, flow);
                        });
                    } else {
                        log.debug("monitor:flow:duplicated", key);
                    }
                } else if (err == null) {
                    flow.nts = Date.now() / 1000;
                    this.fcache[fullkey] = flow;
                    this.saveSpecFlow(direction, ip, flow, (err) => {
                        callback(null, direction, flow);
                    });
                }
            });
        }
    }

    /* Sample Spec
    Monitor:Flow:In MonitorEvent 192.168.2.225 { direction: 'in',
      txRanked: 
       [ { ts: 1466695174.518089,
           sh: '192.168.2.225',
           dh: '52.37.161.188',
           ob: 45449694,
           rb: 22012400,
           ct: 13705,
           fd: 'in',
           lh: '192.168.2.225',
           du: 1176.5127850000029,
           bl: 0,
           shname: 'raspbNetworkScan',
           dhname: 'iot.encipher.io',
           org: '!',
           txratio: 2.0647314241064127 } ],
      rxRanked: 
    */

    run(service,period) {
            hostManager.getHosts((err, result) => {
                this.fcache = {}; //temporary cache preventing sending duplicates, while redis is writting to disk
                for (let j in result) {
                    let host = result[j];
                    let listip = [];
                    listip.push(host.o.ipv4Addr);
                    if (host.ipv6Addr && host.ipv6Addr.length > 0) {
                        for (let p in host['ipv6Addr']) {
                            listip.push(host['ipv6Addr'][p]);
                        }
                    }
                    if (service == null || service == "dlp") {
                        this.flows(listip, period, (err, inSpec, outSpec) => {
                            console.log("=================================================================================");
                            log.debug("monitor:flow:", host.toShortString());
                            log.debug("inspec", inSpec);
                            log.debug("outspec", outSpec);
                            console.log("<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<");
                            if (outSpec) {
                                if ((outSpec.txRanked && outSpec.txRanked.length > 0) ||
                                    (outSpec.rxRanked && outSpec.rxRanked.length > 0) ||
                                    (outSpec.txRatioRanked && outSpec.txRatioRanked.length > 0)) {
                                    console.log("=======", outSpec);
                                    this.processSpec("out", outSpec.txRatioRanked, (err, direction, flow) => {
                                        if (flow) {
                                            this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                direction: "out",
                                                "txRatioRanked": [flow]
                                            });
                                            let copy = JSON.parse(JSON.stringify(flow));
                                            let msg = "Warning: " + flowManager.toStringShortShort2(flow, 'out', 'txdata');
                                            copy.msg = msg;
                                            let actionobj = {
                                                title: "Suspicious Large Upload",
                                                actions: ["block","ignore"],
                                                src: flow.dh,
                                                dst: flow.sh,
                                                target: flow.lhost,
                                              //info: ,
                                              //infourl:
                                                msg: msg
                                            }
                                            alarmManager.alarm(host.o.ipv4Addr, "outflow", 'major', '50', copy, actionobj);
                                        }
                                    });
                                }
                            }
                            if (inSpec) {
                                if ((inSpec.txRanked && inSpec.txRanked.length > 0) ||
                                    (inSpec.rxRanked && inSpec.rxRanked.length > 0) ||
                                    (inSpec.txRatioRanked && inSpec.txRatioRanked.length > 0)) {
                                    console.log("=======", inSpec);
                                    this.processSpec("in", inSpec.txRatioRanked, (err, direction, flow) => {
                                        if (flow) {
                                            this.publisher.publish("MonitorEvent", "Monitor:Flow:Out", host.o.ipv4Addr, {
                                                direction: "in",
                                                "txRatioRanked": [flow]
                                            });
                                            let copy = JSON.parse(JSON.stringify(flow));
                                            let msg = "Warning: " + flowManager.toStringShortShort2(flow, 'in', 'txdata');
                                            copy.msg = msg;
                                            let actionobj = {
                                                title: "Suspicious Large Upload",
                                                actions: ["block","ignore"],
                                                src: flow.sh,
                                                dst: flow.dh,
                                                target: flow.lhost,
                                                msg: msg
                                            }
                                            alarmManager.alarm(host.o.ipv4Addr, "inflow", 'major', '50', copy, actionobj);
                                        }
                                    });
                                }
                            }
                        });
                    } else if (service == "detect") {
                        log.debug("Running Detect");
                        this.detect(listip, period, host, (err) => {
                        });
                    }
                }
            });
        }
        // Reslve v6 or v4 address into a local host
}

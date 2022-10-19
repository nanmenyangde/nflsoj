const cheerio = require("cheerio")
const req = require("./request")
const basic = require("./basic")
const retry = require('async-retry')
const interfaces = require('../libs/judger_interfaces')

const TurndownService = require('turndown')
const {TaskStatus} = require("../libs/judger_interfaces");

const turndownService = new TurndownService()

const statementProcess = (statementHtml) => {
    let s = turndownService.turndown(statementHtml)
    s =  s.replaceAll("$$$", "$")
    let ret = ""
    let isLetter = /[A-Za-z]/
    for(let i = 0; i < s.length; i++) {
        if(s[i] !== '\\' || isLetter.test(s[i + 1])) ret += s[i]
    }
    return ret
}
const examplesProcess = (mainContent, type) => {
    const examples = []
    const selector =  'div[class="' + type + '"] pre'
    mainContent(selector).each((i, ele) => {
        const x = cheerio.load(ele)
        let str = ''
        x('div').each((_, y) => {
            if(str !== '') str += '\n'
            str += x(y).text()
        })
        if (str === '') str = x.text().trim()
        examples.push(str)
    })
    return examples
}

const parseProblemId = problemId => { // 1200A => cotestID:1200 submittedProblemIndex: A
    let ret = {
        contestId: '',
        submittedProblemIndex: '',
    }
    let pos = 0
    while (pos < problemId.length) {
        if(/[A-Z]/.test(problemId[pos])) break
        pos++
    }
    if(pos < problemId.length) {
        ret.contestId = problemId.substring(0, pos)
        ret.submittedProblemIndex = problemId.substring(pos)
    }
    return ret
}

const cfStatusMapSyzOjStatus = {
    'Accepted': 'Accepted',
    'Wrong answer': 'Wrong Answer',
    'Runtime error': 'Runtime Error',
    'Time limit exceeded': 'Time Limit Exceeded',
    'Memory limit exceeded': 'Memory Limit Exceeded',
    'Compilation error': 'Compile Error',
    'Running': 'Waiting',
    'queue': 'Waiting',
    'Pending': 'Waiting',
}

const inJudging= status => {
    return status.indexOf("Running") !== -1 || status.indexOf("Pending") !== -1 || status.indexOf("queue") !== -1
}

const changeToSyzOjStatus = (status) => {
    for(let key in cfStatusMapSyzOjStatus) {
        if(status.indexOf(key) === -1) continue
        return cfStatusMapSyzOjStatus[key]
    }
    return 'Runtime Error'
}

class Handler {
    constructor(handleOrEmail="", password="") {
        this.req = new req.Request('https://codeforces.com/')
        this.xCsrfToken = ''
        this.handleOrEmail = handleOrEmail
        this.password = password
        this.queue = []
        this.inPolling = false

        // 自动更新 xCsrfToken
        this.req.addRequestAfterFunc(res => {
            if (res.body && res.body !== '') {
                if(this.xCsrfToken !== '') return
                const $ = cheerio.load(res.body)
                let xCsrfToken = $('meta[name="X-Csrf-Token"]').prop('content')
                if (xCsrfToken && xCsrfToken !== '') this.xCsrfToken = xCsrfToken
            }
        })
    }

    async initXCsrfToken() {
        if (this.xCsrfToken !== '') return
        let opts = {
            url: "enter",
            method: 'GET',
        }
        await this.req.doRequest(opts)
    }

    async login() {
        await this.initXCsrfToken()
        let data = {
            handleOrEmail: this.handleOrEmail,
            password: this.password,
            action: 'enter',
            csrf_token: this.xCsrfToken,
            remember: "on"
        }
        let opts = {
            url: "enter",
            method: 'POST',
            form: data
        }
        await this.req.doRequest(opts)
    }

    async loginIfNotLogin() {
        if (!this.req.cookie.cookies.hasOwnProperty("X-User-Sha1") || this.xCsrfToken === '') await this.login()
    }

    // 获取 html 第一份代码的 id
    async getSubmissionID(contestId, retries = 3) {
        await this.loginIfNotLogin()
        let opts = {
            url: "contest/" + contestId + "/my",
            method: 'GET',
        }
        return await retry(async () => {
            const res = await this.req.doRequest(opts)
            const $ = cheerio.load(res.body)
            let submissionId = $('a[class="view-source"]').prop("submissionid")
            if(submissionId === null) throw "获取失败 submission id fail"
            return submissionId
        }, { retries: retries })
    }

    async getSubmissionStatus(submissionId) {
        let opts = {
            url: 'data/submitSource',
            method: 'POST',
            form: {
                submissionId,
                csrf_token: this.xCsrfToken,
            }
        }
        const res = await this.req.doRequest(opts)
        const result = JSON.parse(res.body)
        const verdict = cheerio.load(result['verdict']).text().trim()
        if(verdict === '') throw "获取submission status 失败"
        const is_over = !inJudging(verdict)
        let ret = {
            status: changeToSyzOjStatus(verdict),
            info: verdict,
            is_over,
            type: syzoj.ProblemType.Remote
        }
        if (is_over) {
            if (ret.status === 'Compile Error') {
                ret.compile = {
                    message: result['checkerStdoutAndStderr#1']
                }
            } else {
                let testCount = parseInt(result['testCount'])
                let time = 0, memory = 0, score = ret.status === 'Accepted' ? 100 : 0
                let cases = new Array(testCount)
                for (let i = 1; i <= testCount; ++i) {
                    let _memory = Math.floor(parseInt(result['memoryConsumed#' + i]) / 1024) //KB
                    let _time = Math.max(time, parseInt(result['timeConsumed#' + i]))
                    memory = Math.max(memory, _memory)
                    time = Math.max(time, _time)
                    cases[i - 1] = {
                        status: TaskStatus.Done,
                        result: {
                            type: (i < testCount) ? interfaces.TestcaseResultType.Accepted : interfaces.TestcaseResultType[ret.status.replaceAll(' ', '')],
                            scoringRate: (i < testCount) ? 1 : (score / 100),
                            memory: _memory,
                            time: _time,
                            input: {
                                name: '---',
                                content: result['input#' + i],
                            },
                            output: {
                                name: '---',
                                content: result['answer#' + i],
                            },
                            userOutput: result['output#' + i],
                            spjMessage: result['checkerStdoutAndStderr#' + i],
                        }
                    }
                }
                ret.judge = {
                    subtasks: [{score, cases}],
                }
                ret.time = time
                ret.memory = memory
                ret.score = score
            }
        }
        return ret
    }
    async polling() {
        try {
            await this.loginIfNotLogin()
        } catch (e){
            this.xCsrfToken = ''
            try { await this.login() } catch (e) {}
        }

        while (this.queue.length > 0) {
            const {source, problemID, langId, callback} = this.queue.shift()
            try {
                const {contestId, submittedProblemIndex} =  parseProblemId(problemID)
                let opts = {
                    url: "contest/" + contestId + "/submit?csrf_token=" + this.xCsrfToken,
                    method: "POST",
                    form: {
                        csrf_token: this.xCsrfToken,
                        action: "submitSolutionFormSubmitted",
                        tabSize: 4,
                        source: source,
                        contestId,
                        submittedProblemIndex, //E2
                        programTypeId: langId, //C++20
                    }
                }
                const res = await retry( async () => {
                    return await this.req.doRequest(opts)
                }, { retries: 3 })
                if (res.statusCode !== 302) throw '提交失败'
                const submissionId = await this.getSubmissionID(contestId)
                callback(null, submissionId)
            } catch (e) {
                callback(e, 0)
            }
        }
        this.inPolling = false
    }

    async submitCode(source, problemID, langId, callback){ //cb => function(err, submissionId)
        this.queue.push({source, problemID, langId, callback})
        if(!this.inPolling) {
            this.inPolling = true
            this.polling()
        }
    }

    async getProblem(problemId) {
        const {contestId, submittedProblemIndex} = parseProblemId(problemId)
        if(contestId === '') return null
        let opts = {
            url: 'contest/' + contestId + "/problem/" +  submittedProblemIndex,
            method: 'GET'
        }
        const res = await this.req.doRequest(opts)

        const $ = cheerio.load(res.body)

        const maincontent = cheerio.load($('div[class="problem-statement"]').html())

        const title = maincontent('div[class="title"]').eq(0).html().split(". ")[1]
        const time_limit = Number(maincontent('div[class="time-limit"]').text().match(/\d+(.\d+)?/g)[0]) * 1000
        const memory_limit = Number(maincontent('div[class="memory-limit"]').text().match(/\d+(.\d+)?/g)[0])
        const description = statementProcess(maincontent('div').eq(10).html())

        const __input = maincontent('div[class="input-specification"]').html()
        const input_format = __input == null ? "" : statementProcess(__input.substring(__input.indexOf("<p>")))


        const __output = maincontent('div[class="output-specification"]').html()
        const output_format = __output == null ? "" : statementProcess(__output.substring(__output.indexOf("<p>")))


        const __note = maincontent('div[class="note"]').html()
        const limit_and_hint = __note == null ? "" : statementProcess(__note.substring(__note.indexOf("<p>")))


        const examplesInput = examplesProcess(maincontent, "input")
        const examplesOutput = examplesProcess(maincontent, "output")

        return {
            title,
            time_limit,
            memory_limit,
            description,
            input_format,
            output_format,
            limit_and_hint,
            example: basic.changeExampleArrToMarkDown(examplesInput, examplesOutput)
        }
    }
}


class Codeforces {
    constructor() {
        this.base = new Handler()
        this.handlers = basic.VjBasic.Codeforces.accounts.map(account => new Handler(account.handleOrEmail, account.password))
    }
    async getProblem(problemId) {
        return await this.base.getProblem(problemId)
    }


    async getSubmissionStatus(submissionId) {
        return await this.base.getSubmissionStatus(submissionId)
    }

    async submitCode(source, problemID, langId, callback) {
        let index = Math.floor(Math.random() * this.handlers.length)
        let select = index
        let cap = this.handlers[select].queue.length
        for (let i = 1; cap > 0 && i < this.handlers.length; i++) {
            index++;
            if(index >= this.handlers.length) index = 0
            let len = this.handlers[index].queue.length
            if (len < cap) {
                cap = len
                select = index
            }
        }
        this.handlers[select].submitCode(source, problemID, langId, callback)
    }
}

// const codeforces = new Codeforces()
// codeforces.getSubmissionStatus('176856006')



module.exports = {
    Codeforces: new Codeforces()
}
let Contest = syzoj.model('contest');
let ContestRanklist = syzoj.model('contest_ranklist');
let ContestPlayer = syzoj.model('contest_player');
let Problem = syzoj.model('problem');
let JudgeState = syzoj.model('judge_state');
let User = syzoj.model('user');
let Article = syzoj.model('article');
let ProblemEvaluate = syzoj.model('problem_evaluate');
let ProblemForbid =  syzoj.model('problem_forbid')
let ContestCollection = syzoj.model('contest_collection')
const interfaces = require('../libs/judger_interfaces')

const jwt = require('jsonwebtoken');
const { getSubmissionInfo, getRoughResult, processOverallResult } = require('../libs/submissions_process');
const hide_title_replace = "ABCD"

async function contest_check_open(contest){
    let gid = contest.group_id;
    let gids = gid.split('|');
    return gids.indexOf('chk')!=-1 ;
}

async function contest_permitted(contest,user){
    const entityManager = TypeORM.getManager();
    let cid = contest.id;
    let uid = user.id;
    let res = await entityManager.query(`SELECT * from contest_permission where cid=${cid} and uid=${uid}`);
    if(res.length==0) return false;
    let sta = res[0]['status'];
    return ( sta == 'allow' ) ;
}

async function checkgp(contest,user){
    if (user.is_admin || contest.admins.includes(user.id.toString())) return true;
    // return true
    if (!contest.is_public) throw new ErrorMessage('比赛未公开');

    let cts = await user.getconts();

    if( cts.indexOf(contest.id)!=-1 ) {
        return true;
    }
    if( await contest_check_open(contest) && await contest_permitted(contest,user)){
        return true;
    }
    return false;
}

function get_key(username) {
  return syzoj.utils.md5(username + "comp_xxx")
}

const cp_map = new Map()
syzoj.prepare_cp_user_data = prepare_cp_user_data

async function prepare_cp_user_data(user_id) {
  let current = syzoj.utils.getCurrentDate()
  let data = cp_map.get(user_id)
  if(!data || current - data.time > 300) {
    data = {time: current, contests: []}
    let contest_query = Contest.createQueryBuilder().where(`id IN (SELECT contest_id FROM contest_player WHERE user_id=${user_id}) AND end_time <= ${current}`).orderBy('start_time', 'DESC').addOrderBy('id', 'DESC')
    let contests1 = await Contest.queryAll(contest_query)
    let contest_query2 = Contest.createQueryBuilder().where(`id IN (SELECT contest_id FROM contest_collection WHERE user_id=${user_id}) AND end_time <= ${current}`).orderBy('start_time', 'DESC').addOrderBy('id', 'DESC')
    let contests2 = await Contest.queryAll(contest_query2)
    let i = 0, j = 0;
    while(i < contests1.length && j < contests2.length) {
      if(contests1[i].id === contests2[j].id) {
        data.contests.push(contests1[i]); i++; j++
      } else if(contests1[i].start_time >= contests2[j].start_time) {
        data.contests.push(contests1[i]); i++
      } else {
        data.contests.push(contests2[j]); j++
      }
    }
    for(; i < contests1.length; i++) data.contests.push(contests1[i]);
    for(; j < contests2.length; j++) data.contests.push(contests2[j]);
    cp_map.set(user_id, data)
  }
  return data.contests
}

app.get('/contests', async (req, res) => {
  try {
    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let keyword = req.query.keyword;
    let query = Contest.createQueryBuilder();
    if (!keyword) {
      query.where('1 = 1');
    } else {
      query.where('title LIKE :title', { title: `%${keyword}%` });
    }
    
    if (!res.locals.user.is_admin) {
        let mycont = await res.locals.user.getconts();
        if ( mycont.length === 0 ){
          query.andWhere(`group_id like '%chk%'`);
        }else{
          query.andWhere(new TypeORM.Brackets(qb => {
            qb.where(`id IN (:...mycont)`,{mycont:mycont})
              .andWhere(`is_public = 1`)
              .orWhere(`group_id like '%chk%'`);
          }));
        }
    }
    let paginate = syzoj.utils.paginate(await Contest.countForPagination(query), req.query.page, syzoj.config.page.contest);
    let contests = await Contest.queryPage(paginate, query, {
      start_time: 'DESC'
    });

    await contests.forEachAsync(async x => {
      x.subtitle = await syzoj.utils.markdown(x.subtitle);
      if(x.hide_title) x.title = hide_title_replace
    });

    res.render('contests', {
      is_admin: res.locals.user.is_admin,
      contests: contests,
      paginate: paginate
    })
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/cp/user/:id', async (req, res) => {
  try {
    let user = await User.findById(parseInt(req.params.id))
    if(!user) throw new ErrorMessage('无此用户。');
    const local_user = res.locals.user

    let key = req.query.key
    if(key) {
      let key2 = get_key(user.username)
      if(key !== key2) throw new ErrorMessage('key 不正确。');
    } else  if(!local_user || (!local_user.is_admin && local_user.id !== user.id)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    } else {
      key = get_key(user.username)
    }


    let contests = await prepare_cp_user_data(user.id)
    if(req.query.title) {
      contests = contests.filter(c => c.title.includes(req.query.title))
    }

    let count = contests.length
    let paginate = syzoj.utils.paginate(count, req.query.page, syzoj.config.page.contest)

    let start = (paginate.currPage - 1) * paginate.perPage
    contests = contests.slice(start,  start + paginate.perPage)
    let ranklist_map = {}
    let players_map = {}
    if(contests.length > 0) {
      let player_query = ContestPlayer.createQueryBuilder().where(`user_id = ${user.id} AND contest_id IN (${contests.map(c => c.id).join(",")})`)
      let players = await ContestPlayer.queryAll(player_query)
      players.forEach(p => players_map[p.contest_id] = p)
      let ranklists = await ContestRanklist.queryAll(ContestRanklist.createQueryBuilder().where("id in (" + contests.map(item => item.ranklist_id).join(",") + ")"))
      ranklist_map = syzoj.utils.makeRecordsMap(ranklists)
    }



    let data = []
    let not_solved = {}  // problem_id => c array

    for(let contest of contests) {
      let problem_ids = await contest.getProblems()
      let c = {
        rank: '---',
        player_num: '---',
        score: 0, // 比赛得分
        total_score: 0, // 总分
        score_after_contest: 0, // 赛后得分
        contest,
        problem_count: problem_ids.length,
        solved: 0, // 比赛中过题
        solved_count: 0, //总过题，包括赛后补题
      }
      let player = players_map[contest.id]
      let ranklist = ranklist_map[contest.ranklist_id]

      if(ranklist) {
        c.player_num = ranklist.ranklist.player_num
        let players = await ContestPlayer.find({contest_id: contest.id})
        players.forEach(p => p.score = 0)
        for(problem_id of problem_ids) {
          let multipler = (ranklist.ranking_params[problem_id] || 1.0)
          let full_score = multipler * 100
          c.total_score += full_score;
          for(let p of players) {
            let detail = p.score_details[problem_id]
            let score = 0
            if(detail) {
              if(detail.accepted) score = full_score
              else if(detail.score) score = detail.score * multipler
              else if(detail.weighted_score) score = detail.weighted_score
            }
            p.score += score
            if(player && p.user_id === player.user_id) {
              c.score += score
              c.score_after_contest += score
              if(score > 0 && Math.abs(score - full_score) < 0.01) {c.solved_count++; c.solved++}
              else if(not_solved[problem_id]) not_solved[problem_id].push({left_score: full_score - score, c});
              else not_solved[problem_id] = [{left_score: full_score - score, c}]
            }
          }
          if(!player) {
            if(not_solved[problem_id]) not_solved[problem_id].push({left_score: full_score, c});
            else not_solved[problem_id] = [{left_score: full_score, c}]
          }
        }
        if(player) {
          c.rank = 1
          players.forEach(p => c.rank += p.score > c.score ? 1 : 0)
        }
      }
      data.push(c)
    }

    let not_solved_ids = Object.keys(not_solved)
    if(not_solved_ids.length > 0) {
      let sql = 'select distinct problem_id from judge_state where user_id=' + user.id + ' and problem_id in (' + not_solved_ids.join(",")  + ') and status=\'Accepted\''
      let res = await JudgeState.query(sql)
      res.forEach(item => {
        not_solved[item.problem_id].forEach(({left_score, c}) => {
          c.solved_count++
          c.score_after_contest += left_score
        })
      })
    }


    res.render('user_contests', {
      data,
      show_user: user,
      paginate,
      key,
      count
    })
  } catch (e) {
    res.render('error', {
      err: e
    });
  }
})

app.get('/find_contest', async (req, res) => {
  try {
    // let user = await User.fromName(req.query.nickname);
    // if (!user) throw new ErrorMessage('无此用户。');
    // res.redirect(syzoj.utils.makeUrl(['user', user.id]));
    res.redirect(syzoj.utils.makeUrl(['contests'], { keyword: req.query.title }));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/edit', async (req, res) => {
  try {

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    if (!contest) {
      // if contest does not exist, only system administrators can create one
      if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

      contest = await Contest.create();
      contest.id = 0;
      contest.is_public = true;
    } else {
      // if contest exists, both system administrators and contest administrators can edit it.
      if (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString()))) throw new ErrorMessage('您没有权限进行此操作。');

      await contest.loadRelationships();
    }

    let problems = [], admins = [];
    if (contest.problems) problems = await contest.problems.split('|').mapAsync(async id => await Problem.findById(id));
    if (contest.admins) admins = await contest.admins.split('|').mapAsync(async id => await User.findById(id));

    res.render('contest_edit', {
      contest: contest,
      problems: problems,
      admins: admins
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/edit', async (req, res) => {
  try {

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    let ranklist = null;
    if (!contest) {
      // if contest does not exist, only system administrators can create one
      if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

      contest = await Contest.create();

      contest.holder_id = res.locals.user.id;

      ranklist = await ContestRanklist.create();

      // Only new contest can be set type
      if (!['noi', 'ioi', 'acm', 'pc'].includes(req.body.type)) throw new ErrorMessage('无效的赛制。');
      contest.type = req.body.type;
    } else {
      // if contest exists, both system administrators and contest administrators can edit it.
      if (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString()))) throw new ErrorMessage('您没有权限进行此操作。');
      
      await contest.loadRelationships();
      ranklist = contest.ranklist;
    }

    try {
      ranklist.ranking_params = JSON.parse(req.body.ranking_params);
    } catch (e) {
      ranklist.ranking_params = {};
    }
    await ranklist.save();
    contest.ranklist_id = ranklist.id;

    if (!req.body.title.trim()) throw new ErrorMessage('比赛名不能为空。');
    contest.title = req.body.title;
    contest.subtitle = req.body.subtitle;
    if (!Array.isArray(req.body.problems)) req.body.problems = [req.body.problems];
    if (!Array.isArray(req.body.admins)) req.body.admins = [req.body.admins];
    contest.problems = req.body.problems.join('|');
    contest.admins = req.body.admins.join('|');
    contest.information = req.body.information;
    contest.start_time = syzoj.utils.parseDate(req.body.start_time);
    contest.end_time = syzoj.utils.parseDate(req.body.end_time);
    contest.is_public = req.body.is_public === 'on';
    contest.hide_statistics = req.body.hide_statistics === 'on';
    contest.hide_username = req.body.hide_username === 'on';
    contest.hide_title = req.body.hide_title === 'on'

    contest.group_id = req.body.group_id;

    await contest.save();

    res.redirect(syzoj.utils.makeUrl(['contest', contest.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id', async (req, res) => {
  try {


    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    const curUser = res.locals.user;
    let contest_id = parseInt(req.params.id);

    let contest = await Contest.findById(contest_id);
    if (!contest) throw new ErrorMessage('无此比赛。');

    const isSupervisior = await contest.isSupervisior(curUser);

    if(!isSupervisior){
        if( await checkgp(contest,res.locals.user) ){
            ;
        }else{
          if(await contest_check_open(contest) ){
                if( await contest_permitted(contest,res.locals.user) ){
                    ;
                }else{
                    throw new ErrorMessage(
                        '请申请访问比赛,并等待管理员同意!',
                        {
                            '申请访问': syzoj.utils.makeUrl(['dp/chk/contest_permission_require.php?cid='+contest_id])
                        }
                    );
                }
            }else
                throw new ErrorMessage('group not included, cannot enter !');
        }
    }

    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    contest.running = contest.isRunning();
    contest.ended = contest.isEnded();



    // if ((!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString()))) && (!contest.isRunning () && !contest.isEnded ())) throw new ErrorMessage('比赛未开始，请耐心等待 (´∀ `)');

    contest.subtitle = await syzoj.utils.markdown(contest.subtitle);
    contest.information = await syzoj.utils.markdown(contest.information);

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    let player = null;

    if (res.locals.user) {
      player = await ContestPlayer.findInContest({
        contest_id: contest.id,
        user_id: res.locals.user.id
      });
    }

    if(contest.ended) {
      contest.open_problem = false
      for(let p of problems) {
        contest.open_problem |= !p.is_public
      }
    } else if(contest.hide_title){
      contest.title = hide_title_replace
    }

    problems = problems.map(x => ({ problem: x, status: null, judge_id: null, statistics: null }));


    for(let problem of problems){
        problem.buti_judge = await problem.problem.getJudgeState(res.locals.user,true);
        problem.tags = await problem.problem.getTags();
        problem.allowedEvaluate = await problem.problem.isAllowedEvaluateBy(res.locals.user);
        problem.like_num = await ProblemEvaluate.getEvaluate(problem.problem.id, 'Like');
        problem.hate_num = await ProblemEvaluate.getEvaluate(problem.problem.id, 'Hate');
        problem.evaluate = await ProblemEvaluate.getUserEvaluate(problem.problem.id, res.locals.user.id);
    }

    if (player) {
      for (let problem of problems) {
        if (contest.type === 'noi') {
          if (player.score_details[problem.problem.id]) {
            let judge_state = await JudgeState.findById(player.score_details[problem.problem.id].judge_id);
            problem.status = judge_state.score.toString();
            if (!contest.ended && !await problem.problem.isAllowedEditBy(res.locals.user) && !['Compile Error', 'Waiting', 'Compiling'].includes(problem.status)) {
              problem.status = 'Submitted';
            }
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
          }
        } else if (contest.type === 'ioi' || contest.type === 'pc') {
          if (player.score_details[problem.problem.id]) {
            let judge_state = await JudgeState.findById(player.score_details[problem.problem.id].judge_id);
            problem.status = judge_state.status;
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
            await contest.loadRelationships();
            let multiplier = contest.ranklist.ranking_params[problem.problem.id] || 1.0;
            problem.feedback = (judge_state.score * multiplier).toString() + ' / ' + (100 * multiplier).toString();
          }
        } else if (contest.type === 'acm') {
          if (player.score_details[problem.problem.id]) {
            problem.status = {
              accepted: player.score_details[problem.problem.id].accepted,
              unacceptedCount: player.score_details[problem.problem.id].unacceptedCount
            };
            problem.judge_id = player.score_details[problem.problem.id].judge_id;
          } else {
            problem.status = null;
          }
        }
      }
    }

    let hasStatistics = false;
    if ((!contest.hide_statistics) || (contest.ended) || (isSupervisior)) {
      hasStatistics = true;

      await contest.loadRelationships();
      let players = await contest.ranklist.getPlayers();
      for (let problem of problems) {
        problem.statistics = { attempt: 0, accepted: 0 };

        if (contest.type === 'ioi' || contest.type === 'noi' || contest.type === 'pc') {
          problem.statistics.partially = 0;
        }

        for (let player of players) {
          if (player.score_details[problem.problem.id]) {
            problem.statistics.attempt++;
            if ((contest.type === 'acm' && player.score_details[problem.problem.id].accepted) || ((contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') && player.score_details[problem.problem.id].score === 100)) {
              problem.statistics.accepted++;
            }

            if ((contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') && player.score_details[problem.problem.id].score > 0) {
              problem.statistics.partially++;
            }
          }
        }
      }
    }

    await contest.loadRelationships();
    let weight = null;

    for (let i = 0; i < problems.length; ++i) {
      if (contest.ranklist.ranking_params[problems[i].problem.id]) {
        weight = []; break;
      }
    }

    if (weight != null) {
      for (let i = 0; i < problems.length; ++i) {
        let multiplier = contest.ranklist.ranking_params[problems[i].problem.id] || 1.0;
        let full_score = Math.round (multiplier * 100);
        weight.push (full_score);
      }
    }


    //是否可以收藏比赛
    let existContestCollection = -1
    if(contest.ended && !player) {
      let cc = await ContestCollection.findOne({contest_id: contest.id, user_id: curUser.id})
      existContestCollection = cc ? 1 : 0;
    }

    res.render('contest', {
      contest: contest,
      problems: problems,
      hasStatistics: hasStatistics,
      isSupervisior: isSupervisior,
      weight: weight,
      username: curUser.username,
      existContestCollection
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/repeat', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!contest.isEnded ()) throw new ErrorMessage('比赛未结束，请耐心等待 (´∀ `)');
    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('您没有权限进行此操作。');

      // if (await checkgp(contest, res.locals.user)) {
      //   ;
      // } else {
      //   throw new ErrorMessage('group not included, cannot enter !');
      // }


    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    let repeatlist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);
      let user = await User.findById(player.user_id);
      let number = 0;
      let prob = await problems.mapAsync (async problem => {
        let buti_judge = await problem.getJudgeState (user, true);
        if (buti_judge && buti_judge.status == 'Accepted') ++number;
        return {
          buti_judge: buti_judge
        };
      });

      return {
        number: number,
        user: user,
        problems: prob
      };
    });

    for (let i = 0; i < problems.length; ++i) problems[i].buti_num = 0;
    for (let it of repeatlist) {
      for (let i = 0; i < problems.length; ++i) {
        if (it.problems[i].buti_judge && it.problems[i].buti_judge.status == 'Accepted') ++problems[i].buti_num;
      }
    }

    repeatlist.sort (function(a, b){return b.number-a.number});

    res.render('contest_repeat', {
      hide_problem_title: problems.length >= 6,
      main_style: problems.length >= 6 ? 'width: auto!important;' : undefined,
      local_is_admin: res.locals.user.is_admin,
      contest: contest,
      repeatlist: repeatlist,
      problems: problems,
      key: null
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/repeat/:prefix', async (req, res) => {
  try {
    let key = req.query.key
    if(!key) {
      if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}
    }

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);

    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!contest.isEnded ()) throw new ErrorMessage('比赛未结束，请耐心等待 (´∀ `)');

    const curUser = res.locals.user;
    let local_is_admin = curUser && curUser.is_admin
    let pkey = get_key(req.params.prefix)

    if(pkey !== key) {
      // if contest is non-public, both system administrators and contest administrators can see it.

      if(!curUser) throw new ErrorMessage('您没有权限进行此操作。');

      if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('您没有权限进行此操作。');


        // if (await checkgp(contest, res.locals.user)) {
        //   ;
        // } else {
        //   throw new ErrorMessage('group not included, cannot enter !');
        // }

      key = pkey
    }

    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    let repeatlist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);
      let user = await User.findById(player.user_id);
      let number = 0;
      let prob = await problems.mapAsync (async problem => {
        let buti_judge = await problem.getJudgeState (user, true);
        if (buti_judge && buti_judge.status == 'Accepted') ++number;
        return {
          buti_judge: buti_judge
        };
      });

      return {
        number: number,
        user: user,
        problems: prob
      };
    });

    repeatlist = repeatlist.filter(item => item.user.nickname.startsWith(req.params.prefix));

    for (let i = 0; i < problems.length; ++i) problems[i].buti_num = 0;
    for (let it of repeatlist) {
      for (let i = 0; i < problems.length; ++i) {
        if (it.problems[i].buti_judge && it.problems[i].buti_judge.status == 'Accepted') ++problems[i].buti_num;
      }
    }

    repeatlist.sort (function(a, b){return b.number-a.number});

    res.render('contest_repeat', {
      hide_problem_title: problems.length >= 6,
      main_style: problems.length >= 6 ? 'width: auto!important;' : undefined,
      local_is_admin,
      contest: contest,
      repeatlist: repeatlist,
      problems: problems,
      key,
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/ranklist', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    const curUser = res.locals.user;

    if (!contest) throw new ErrorMessage('无此比赛。');
    // if contest is non-public, both system administrators and contest administrators can see it.


    if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    if ([contest.allowedSeeingResult() && contest.allowedSeeingOthers(),
    contest.isEnded(),
    await contest.isSupervisior(curUser)].every(x => !x))
      throw new ErrorMessage('您没有权限进行此操作。');

    //
    // if ( await checkgp(contest,res.locals.user) ){
    //   ;
    // }else{
    //   throw new ErrorMessage('group not included, cannot enter !');
    // }


    if (!contest.isRunning () && !contest.isEnded ()) throw new ErrorMessage('比赛未开始，请耐心等待 (´∀ `)');

    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);

    let ranklist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);

      if (contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') {
        player.score = 0;
      }

      for (let i in player.score_details) {
        player.score_details[i].judge_state = await JudgeState.findById(player.score_details[i].judge_id);

        /*** XXX: Clumsy duplication, see ContestRanklist::updatePlayer() ***/
        if (contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') {
          let multiplier = (contest.ranklist.ranking_params || {})[i] || 1.0;
          player.score_details[i].weighted_score = player.score_details[i].score == null ? null : Math.round(player.score_details[i].score * multiplier);
          player.score += player.score_details[i].weighted_score;
        }
      }

      let user = await User.findById(player.user_id);

      return {
        user: user,
        player: player
      };
    });

    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    for (let i = 0; i < problems.length; ++i) problems[i].ac_num = 0, problems[i].total = 0, problems[i].avg_score = 0.0;
    for (let it of ranklist) {
      for (let i = 0; i < problems.length; ++i) {
        if (!it.player.score_details[problems[i].id] || !it.player.score_details[problems[i].id].judge_state) continue;
        if (it.player.score_details[problems[i].id].judge_state.status == 'Accepted') ++problems[i].ac_num;
        ++problems[i].total;
        problems[i].avg_score += it.player.score_details[problems[i].id].score;
      }
    }
    for (let i = 0; i < problems.length; ++i) problems[i].avg_score /= problems[i].total;

    res.render('contest_ranklist', {
      hide_problem_title: problems.length >= 6,
      main_style: problems.length >= 6 ? 'width: auto!important;' : undefined,
      local_is_admin: res.locals.user.is_admin,
      contest: contest,
      ranklist: ranklist,
      problems: problems,
      key: null,
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});


app.get('/contest/:id/ranklist/:prefix', async (req, res) => {
  try {

    let key = req.query.key
    if(!key) {
      if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}
    }

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);

    if (!contest) throw new ErrorMessage('无此比赛。');

    if (!contest.isRunning () && !contest.isEnded ()) throw new ErrorMessage('比赛未开始，请耐心等待 (´∀ `)');

    const curUser = res.locals.user;
    let pkey = get_key(req.params.prefix)
    let local_is_admin = curUser && curUser.is_admin
    //权限认证:
    if(pkey !== key) {

      if(!curUser) throw new ErrorMessage('您没有权限进行此操作。');
      // if contest is non-public, both system administrators and contest administrators can see it.
      if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

      if ([contest.allowedSeeingResult() && contest.allowedSeeingOthers(),
        contest.isEnded(),
        await contest.isSupervisior(curUser)].every(x => !x))
        throw new ErrorMessage('您没有权限进行此操作。');

      // if ( await checkgp(contest,res.locals.user) ){
      //   ;
      // }else{
      //   throw new ErrorMessage('group not included, cannot enter !');
      // }

      key = pkey
    } else if(contest.isRunning() && !local_is_admin) throw new ErrorMessage('比赛未结束，请耐心等待 (´∀ `)');


    await contest.loadRelationships();

    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);

    let ranklist = await players_id.mapAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);

      if (contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') {
        player.score = 0;
      }

      for (let i in player.score_details) {
        player.score_details[i].judge_state = await JudgeState.findById(player.score_details[i].judge_id);

        /*** XXX: Clumsy duplication, see ContestRanklist::updatePlayer() ***/
        if (contest.type === 'noi' || contest.type === 'ioi' || contest.type === 'pc') {
          let multiplier = (contest.ranklist.ranking_params || {})[i] || 1.0;
          player.score_details[i].weighted_score = player.score_details[i].score == null ? null : Math.round(player.score_details[i].score * multiplier);
          player.score += player.score_details[i].weighted_score;
        }
      }

      let user = await User.findById(player.user_id);

      return {
        user: user,
        player: player,
      };
    });

    let prefix_arr = req.params.prefix.split(",")
    if(prefix_arr.length > 1) {
      prefix_arr = prefix_arr.filter(item => item !== '')
      ranklist = ranklist.filter(item => prefix_arr.some(p => item.user.nickname.startsWith(p)));
    } else {
      // ranklist = ranklist.filter(item => item.user.nickname.startsWith(req.params.prefix));
      ranklist.forEach(item => {
        if(!item.user.nickname.startsWith(req.params.prefix)) item.user.nickname = item.user.username = "***"
      })
    }




    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));

    for (let i = 0; i < problems.length; ++i) problems[i].ac_num = 0, problems[i].total = 0, problems[i].avg_score = 0.0;
    for (let it of ranklist) {
      for (let i = 0; i < problems.length; ++i) {
        if (!it.player.score_details[problems[i].id] || !it.player.score_details[problems[i].id].judge_state) continue;
        if (it.player.score_details[problems[i].id].judge_state.status == 'Accepted') ++problems[i].ac_num;
        ++problems[i].total;
        problems[i].avg_score += it.player.score_details[problems[i].id].score;
      }
    }
    for (let i = 0; i < problems.length; ++i) problems[i].avg_score /= problems[i].total;

    res.render('contest_ranklist', {
      hide_problem_title: problems.length >= 6,
      main_style: problems.length >= 6 ? 'width: auto!important;' : undefined,
      local_is_admin,
      contest: contest,
      ranklist: ranklist,
      problems: problems,
      key,
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});


function getDisplayConfig(contest) {
  return {
    showScore: contest.allowedSeeingScore(),
    showUsage: false,
    showCode: false,
    showResult: contest.allowedSeeingResult(),
    showOthers: contest.allowedSeeingOthers(),
    showDetailResult: contest.allowedSeeingTestcase(),
    showTestdata: false,
    inContest: true,
    showRejudge: false
  };
}

app.get('/contest/:id/submissions', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    // if contest is non-public, both system administrators and contest administrators can see it.
    if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !contest.admins.includes(res.locals.user.id.toString())))) throw new ErrorMessage('比赛未公开，请耐心等待 (´∀ `)');

    if (contest.isEnded()) {
      res.redirect(syzoj.utils.makeUrl(['submissions'], { contest: contest_id }));
      return;
    }

    // if ( await checkgp(contest,res.locals.user) ){
    //     ;
    // }else{
    //     throw new ErrorMessage('group not included, cannot enter !');
    // }

    const displayConfig = getDisplayConfig(contest);
    let problems_id = await contest.getProblems();
    const curUser = res.locals.user;

    let user = req.query.submitter && await User.fromName(req.query.submitter);

    let query = JudgeState.createQueryBuilder();

    let isFiltered = false;
    if (displayConfig.showOthers) {
      if (user) {
        query.andWhere('user_id = :user_id', { user_id: user.id });
        isFiltered = true;
      }
    } else {
      if (curUser == null || // Not logined
        (user && user.id !== curUser.id)) { // Not querying himself
        throw new ErrorMessage("您没有权限执行此操作。");
      }
      query.andWhere('user_id = :user_id', { user_id: curUser.id });
      isFiltered = true;
    }

    if (displayConfig.showScore) {
      let minScore = parseInt(req.body.min_score);
      if (!isNaN(minScore)) query.andWhere('score >= :minScore', { minScore });
      let maxScore = parseInt(req.body.max_score);
      if (!isNaN(maxScore)) query.andWhere('score <= :maxScore', { maxScore });

      if (!isNaN(minScore) || !isNaN(maxScore)) isFiltered = true;
    }

    if (req.query.language) {
      if (req.body.language === 'submit-answer') {
        query.andWhere(new TypeORM.Brackets(qb => {
          qb.orWhere('language = :language', { language: '' })
            .orWhere('language IS NULL');
        }));
      } else if (req.body.language === 'non-submit-answer') {
        query.andWhere('language != :language', { language: '' })
             .andWhere('language IS NOT NULL');
      } else {
        query.andWhere('language = :language', { language: req.body.language })
      }
      isFiltered = true;
    }

    if (displayConfig.showResult) {
      if (req.query.status) {
        query.andWhere('status = :status', { status: req.query.status });
        isFiltered = true;
      }
    }

    if (req.query.problem_id) {
      problem_id = problems_id[parseInt(req.query.problem_id) - 1] || 0;
      query.andWhere('problem_id = :problem_id', { problem_id })
      isFiltered = true;
    }

    query.andWhere('type = 1')
         .andWhere('type_info = :contest_id', { contest_id });

    let judge_state, paginate;

    if (syzoj.config.submissions_page_fast_pagination) {
      const queryResult = await JudgeState.queryPageFast(query, syzoj.utils.paginateFast(
        req.query.currPageTop, req.query.currPageBottom, syzoj.config.page.judge_state
      ), -1, parseInt(req.query.page));

      judge_state = queryResult.data;
      paginate = queryResult.meta;
    } else {
      paginate = syzoj.utils.paginate(
        await JudgeState.countQuery(query),
        req.query.page,
        syzoj.config.page.judge_state
      );
      judge_state = await JudgeState.queryPage(paginate, query, { id: "DESC" }, true);
    }

    await judge_state.forEachAsync(async obj => {
      await obj.loadRelationships();
      obj.problem_id = problems_id.indexOf(obj.problem_id) + 1;
      obj.problem.title = syzoj.utils.removeTitleTag(obj.problem.title);
    });


    let page = req.query.no_jump ?  'submissions_modal' : 'submissions'

    const pushType = displayConfig.showResult ? 'rough' : 'compile';
    res.render(page, {
      local_is_admin: res.locals.user.is_admin,
      contest: contest,
      items: judge_state.map(x => ({
        info: getSubmissionInfo(x, displayConfig),
        token: (getRoughResult(x, displayConfig) == null && x.task_id != null) ? jwt.sign({
          taskId: x.task_id,
          type: pushType,
          displayConfig: displayConfig
        }, syzoj.config.session_secret) : null,
        result: getRoughResult(x, displayConfig),
        remote: x.isRemoteTask(),
        running: false,
      })),
      paginate: paginate,
      form: req.query,
      displayConfig: displayConfig,
      pushType: pushType,
      isFiltered: isFiltered,
      fast_pagination: syzoj.config.submissions_page_fast_pagination
    });
  } catch (e) {
    syzoj.log(e);
    res.render(req.query.no_jump ? 'error_modal': 'error', {
      err: e
    });
  }
});


app.get('/contest/submission/:id', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    const id = parseInt(req.params.id);
    const judge = await JudgeState.findById(id);
    if (!judge) throw new ErrorMessage("提交记录 ID 不正确。");
    const curUser = res.locals.user;
    if ((!curUser) || judge.user_id !== curUser.id) throw new ErrorMessage("您没有权限执行此操作。");

    if (judge.type !== 1) {
      return res.redirect(syzoj.utils.makeUrl(['submission', id]));
    }

    if(!res.locals.user.is_admin && !(res.locals.user.id === judge.user_id)) {
      let pf = await ProblemForbid.findOne({problem_id: judge.problem_id})
      if(pf && pf.forbid_submission_end_time > syzoj.utils.getCurrentDate())  throw new ErrorMessage('禁止查看代码。');
    }

    const contest = await Contest.findById(judge.type_info);
    contest.ended = contest.isEnded();

    const displayConfig = getDisplayConfig(contest);
    displayConfig.showCode = true;

    await judge.loadRelationships();
    const problems_id = await contest.getProblems();
    judge.problem_id = problems_id.indexOf(judge.problem_id) + 1;
    judge.problem.title = syzoj.utils.removeTitleTag(judge.problem.title);

    if (judge.problem.type !== 'submit-answer') {
      judge.codeLength = Buffer.from(judge.code).length;
      judge.code = await syzoj.utils.highlight(judge.code, syzoj.languages[judge.language].highlight);
    }

    let page = req.query.no_jump ?  'submission_modal' : 'submission'
    res.render(page, {
      local_is_admin: res.locals.user.is_admin,
      allow_code_copy: syzoj.config.allow_code_copy || res.locals.user.is_admin || res.locals.user.id === judge.user_id,
      allow_tag_edit: res.locals.user.is_admin || (contest.ended && syzoj.config.allow_tag_edit && judge.user_id === res.locals.user.id && judge.status === 'Accepted'),
      info: getSubmissionInfo(judge, displayConfig),
      roughResult: getRoughResult(judge, displayConfig),
      vj_info: judge.vj_info,
      remote: judge.isRemoteTask(),
      code: (displayConfig.showCode && judge.problem.type !== 'submit-answer') ? judge.code.toString("utf8") : '',
      formattedCode: judge.formattedCode ? judge.formattedCode.toString("utf8") : null,
      preferFormattedCode: res.locals.user ? res.locals.user.prefer_formatted_code : false,
      detailResult: processOverallResult(judge.result, displayConfig),
      socketToken: (displayConfig.showDetailResult && judge.pending && judge.task_id != null) ? jwt.sign({
        taskId: judge.task_id,
        displayConfig: displayConfig,
        type: 'detail'
      }, syzoj.config.session_secret) : null,
      displayConfig: displayConfig,
      contest: contest,
    });
  } catch (e) {
    syzoj.log(e);
    res.render(req.query.no_jump ? 'error_modal': 'error', {
      err: e
    });
  }
});

app.get('/contest/:id/problem/:pid', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    const curUser = res.locals.user;

    if (await checkgp(contest,res.locals.user) ){
        ;
    }else{
        throw new ErrorMessage('group not included, cannot enter !');
    }

    let problems_id = await contest.getProblems();

    let pid = parseInt(req.params.pid);
    if (!pid || pid < 1 || pid > problems_id.length) throw new ErrorMessage('无此题目。');

    let problem_id = problems_id[pid - 1];
    let problem = await Problem.findById(problem_id);
    await problem.loadRelationships();

    contest.ended = contest.isEnded();
    if (!await contest.isSupervisior(curUser) && !(contest.isRunning() || contest.isEnded())) {
      // if (await problem.isAllowedUseBy(res.locals.user)) {
      //   return res.redirect(syzoj.utils.makeUrl(['problem', problem_id]));
      // }
      throw new ErrorMessage('比赛尚未开始。');
    }

    problem.specialJudge = await problem.hasSpecialJudge();

    problem.allowedEdit = await problem.isAllowedEditBy(res.locals.user);
    problem.allowedManage = await problem.isAllowedManageBy(res.locals.user);

    await syzoj.utils.markdown(problem, ['description', 'input_format', 'output_format', 'example', 'limit_and_hint']);

    // let state = await problem.getJudgeState(res.locals.user, false);
    let testcases = await syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer');

    let discussionCount = await Article.count({ problem_id: problem_id });

    await problem.loadRelationships();

    let collect_if_submit = contest.ended && await ContestPlayer.count({
      contest_id: contest.id,
      user_id: res.locals.user.id
    }) === 0 && await ContestCollection.count({
      contest_id: contest.id,
      user_id: res.locals.user.id
    }) === 0;

    res.render('problem', {
      collect_if_submit,
      pid: pid,
      contest: contest,
      problem: problem,
      state: null,
      lastLanguage: res.locals.user ? await res.locals.user.getLastSubmitLanguage() : null,
      testcases: testcases,
      discussionCount: discussionCount
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/:pid/rejudge', async (req, res) => {
  try {

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    if (!contest) throw new ErrorMessage('无此比赛。');

    const user = res.locals.user;

    if (user.is_admin || contest.admins.includes(user.id.toString())) ;
    else {
      throw new ErrorMessage("您没有权限执行此操作。");
    }

    let problems_id = await contest.getProblems();

    let pid = parseInt(req.params.pid);
    if (!pid || pid < 1 || pid > problems_id.length) throw new ErrorMessage('无此题目。');

    let problem_id = problems_id[pid - 1];

    await contest.loadRelationships();
    let players = await contest.ranklist.getPlayers();

    players.forEachAsync(async player => {
      let judge = await JudgeState.findById(player.score_details[problem_id].judge_id);
      if (!judge) return;
      if (judge.pending) return;
      await judge.rejudge();
    });

    res.redirect(syzoj.utils.makeUrl(['contest', contest.id, 'problem', pid]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/:pid/download/additional_file', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let id = parseInt(req.params.id);
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');

    if ( await checkgp(contest,res.locals.user) ){
        ;
    }else{
        throw new ErrorMessage('group not included, cannot enter !');
    }

    let problems_id = await contest.getProblems();

    let pid = parseInt(req.params.pid);
    if (!pid || pid < 1 || pid > problems_id.length) throw new ErrorMessage('无此题目。');

    let problem_id = problems_id[pid - 1];
    let problem = await Problem.findById(problem_id);

    contest.ended = contest.isEnded();
    if (!(contest.isRunning() || contest.isEnded())) {
      if (await problem.isAllowedUseBy(res.locals.user)) {
        return res.redirect(syzoj.utils.makeUrl(['problem', problem_id, 'download', 'additional_file']));
      }
      throw new ErrorMessage('比赛尚未开始。');
    }

    await problem.loadRelationships();

    if (!problem.additional_file) throw new ErrorMessage('无附加文件。');

    res.download(problem.additional_file.getPath(), `additional_file_${id}_${pid}.zip`);
  } catch (e) {
    syzoj.log(e);
    res.status(404);
    res.render('error', {
      err: e
    });
  }
});

app.get('/contest/:id/ball', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let id = parseInt(req.params.id);
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

    let query = JudgeState.createQueryBuilder();
    query.where("type_info = :type_info", { type_info: id })
        .andWhere("status = 'Accepted'")

    let results = await JudgeState.queryAll(query);
    let records = {};
    results.forEach(item => {
        let key = "" + item.user_id + "-" + item.problem_id
        if(!records[key]) {
          records[key] = {ball: false, submission: item}
        }
        if(item.vj_info && item.vj_info.ball) records[key].ball = true
    });
    let balls = []
    let problems = await contest.getProblems()
    const ip_map = {
      "31": "D401",
      "32": "D405",
      "33": "D402",
      "34": "D406"
    }
    for (let key in records) {
      let s = records[key]
      if(!s.ball) {
        s.user = await User.findById(s.submission.user_id)

        for(let i = 0; i < problems.length; ++i) {
          if(problems[i] === s.submission.problem_id) {
            s.problem_id = i
            // item.submission.submit_ip.split(",")[0].split(".")[]
            let ip = s.submission.submit_ip.split(",")[0].split(".")
            s.room = ip_map[ip[2]]
            if(s.room) {
              s.room_id = parseInt(s.room.substring(1))
            } else s.room_id = 1000000;
            s.position = parseInt(ip[3]) - 10
            break
          }
        }
        balls.push(s)
      }
    }
    balls.sort((a, b) => {
      return a.room_id - b.room_id
    })

    res.render("contest_balls", {
      balls,
      contest
    })

  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

app.post('/contest/:id/ball/:submission_id', async (req, res) => {
  try {

    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let id = parseInt(req.params.id);
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

    let sid = parseInt(req.params.submission_id)
    let judge_state = await JudgeState.findById(sid)
    if(!judge_state) {
      res.send({error: `no such submission {}`})
      return
    }
    if(!judge_state.vj_info) judge_state.vj_info = {ball: true}; else judge_state.vj_info.ball = true
    await judge_state.save()
    res.send({msg: "ok"})

  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});


app.get('/contest/:id/open_problems', async (req, res) => {
  try {
    let id = parseInt(req.params.id)
    let c = await Contest.findById(id)
    if(!c) throw new ErrorMessage('找不到比赛。');
    if (!res.locals.user || !(await c.isSupervisior(res.locals.user))) throw new ErrorMessage('您没有权限进行此操作。');
    let pids = await c.getProblems()
    await pids.mapAsync(async id => {
      let p = await Problem.findById(id)
      p.is_public = true
      p.publicizer_id = res.locals.user.id;
      p.publicize_time = new Date();
      await p.save();
    });
    res.redirect("/contest/" + id)
  } catch (e) {
    res.render('error', {
      err: e
    })
  }
});

app.get("/contest/:id/pass_info", async (req, res) => {
  try {
    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);

    if (!contest) throw '无此比赛。'
    if (!contest.isEnded ()) throw '比赛未结束，请耐心等待 (´∀ `)';

    await contest.loadRelationships();
    let players_id = [];
    for (let i = 1; i <= contest.ranklist.ranklist.player_num; i++) players_id.push(contest.ranklist.ranklist[i]);
    let problems_id = await contest.getProblems();
    let problems = await problems_id.mapAsync(async id => await Problem.findById(id));
    problems.forEach(p => p.ac_num = 0)

    await players_id.forEachAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);
      let user = await User.findById(player.user_id);
      await problems.forEachAsync(async problem => {
        let buti_judge = await problem.getJudgeState (user, true, true, contest_id);
        if (buti_judge && buti_judge.status == 'Accepted') problem.ac_num++;
      });
    });


    let problem_ac_counts = problems.map(p => p.ac_num)
    res.send({total: contest.ranklist.ranklist.player_num, problem_ac_counts})
  } catch (e) {
    res.send({error: e})
  }
})


app.get('/contest/:id/update_ended_contest_info', async (req, res) => {
  try {
    let id = parseInt(req.params.id)
    let c = await Contest.findById(id)
    if(!c) throw new ErrorMessage('找不到比赛。');
    if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');
    let pids = await c.getProblems()
    await pids.mapAsync(async id => {
      let p = await Problem.findById(id)
      await p.resetSubmissionCount()
    });

    await c.loadRelationships();
    let players_id = [];
    for (let i = 1; i <= c.ranklist.ranklist.player_num; i++) players_id.push(c.ranklist.ranklist[i]);
    await players_id.forEachAsync(async player_id => {
      let player = await ContestPlayer.findById(player_id);
      let user = await User.findById(player.user_id);
      await user.refreshSubmitInfo();
    });

    res.redirect("/contest/" + id)
  } catch (e) {
    res.render('error', {
      err: e
    })
  }
});

app.get('/contest/problem/statistics', async (req, res) => {
  try {
    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}
    if(!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');

    let prefix = req.query.prefix
    let contests = []
    let info = []
    if(prefix) {
      let query = Contest.createQueryBuilder()
      query.where('title LIKE :title', {title: `${prefix}%`})
      contests = await Contest.queryAll(query)
      await contests.forEachAsync(async c => {
        let problems = await c.getProblems()
        for (let pid of problems) {
          let problem = await Problem.create()
          problem.id = pid
          info.push({
            problem_id: pid,
            submit_time: c.start_time,
            tags: await problem.getTags()
          })
        }
      })
      info.sort((a, b) => a.submit_time - b.submit_time)
    }

    let min_time = syzoj.utils.getCurrentDate()
    let max_time = min_time
    if(info.length > 0) {
      min_time = info[0].submit_time
      max_time = info[info.length - 1].submit_time
    }

    res.render('contest_problem_statistics', {prefix, contests, info, min_time, max_time})

  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});

// /contest/<%= contest.id%>/collect
app.get('/contest/:id/collect', async (req, res) => {
  try {
    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    let contest_id = parseInt(req.params.id);
    let contest = await Contest.findById(contest_id);
    if (!contest) throw '无此比赛'


    if (res.locals.user) {
      let player = await ContestPlayer.findInContest({
        contest_id: contest.id,
        user_id: res.locals.user.id
      });
      if(player) throw '你是比赛成员，无需收藏'
    }

    let collection = await ContestCollection.findOne({contest_id: contest.id, user_id: res.locals.user.id})
    collectContest = parseInt(req.query.collectContest)
    cp_map.delete(res.locals.user.id)

    if(collectContest === 0) {
      if(collection) await collection.destroy()
    } else if(collectContest === 1) {
      if(!collection) {
        collection = ContestCollection.create({
          contest_id: contest.id,
          user_id: res.locals.user.id
        })
        await collection.save()
      }
    }

    res.send({msg: "ok"})

  } catch (e) {
    syzoj.log(e);
    res.send({error: e})
  }
});


app.get('/contest/:id/cases_statistics', async (req, res) => {
  try {
    if(!res.locals.user){throw new ErrorMessage('请登录后继续。',{'登录': syzoj.utils.makeUrl(['login'])});}

    const curUser = res.locals.user;

    let id = parseInt(req.params.id)
    let c = await Contest.findById(id)
    if(!c) throw new ErrorMessage('找不到比赛。');


    if (await checkgp(c, curUser) ){
      ;
    }else{
      throw new ErrorMessage('group not included, cannot enter !');
    }


    if (!await c.isSupervisior(curUser) && !c.isEnded()) throw new ErrorMessage('比赛尚未开始。');

    let problemids =  await c.getProblems()

    let problems = await problemids.mapAsync(async pid => {
      let p = await Problem.findById(pid)
      p.cases = {}
      return p
    })

    let submissions = await JudgeState.queryAll(JudgeState.createQueryBuilder().where(`type = 1 AND type_info = ${id}`))
    for (let s of submissions) {
      let p = problems.find(problem => problem.id === s.problem_id)
      if (!p) continue;
      if (s.result && s.result.judge && s.result.judge.subtasks) {
        let subtasks = s.result.judge.subtasks
        if (subtasks.length === 1) {
          if (subtasks[0].cases) {
            subtasks[0].cases.forEach((c, idx) => {
              if (!p.cases[idx]) p.cases[idx] = [];
              if (c.result && c.result.type === interfaces.TestcaseResultType.Accepted && !p.cases[idx].includes(s.user_id))
                p.cases[idx].push(s.user_id)
            })
          }
        } else {
            subtasks.forEach((subtask, idx) => {
              if (!p.cases[idx]) p.cases[idx] = [];
              if(subtask.cases.every(c => c.result && c.result.type === interfaces.TestcaseResultType.Accepted) && !p.cases[idx].includes(s.user_id) )
                p.cases[idx].push(s.user_id)
            })
        }
      }
    }

    let rankList = await ContestRanklist.findById(c.ranklist_id)

    let player_num = rankList ? rankList.ranklist.player_num : 0
    res.render('contest_cases_statistics', {contest: c, problems, player_num })
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
})
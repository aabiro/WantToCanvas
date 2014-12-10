// Set up the state of our game first
var game = {
  characters: [],
  deadCharacters: [],
  currentTurn: {
    state: null,
    actionsRemaining: 0
  },
  explosions: [],
  aimArrow: null
}
// These three variables are to do with "sleeping" the physics engine when things have stopped moving
var sleepVelocityThreshold = 0.001 // If nothing has a velocity higher than this, go to sleep
var canSleep = false // We set this to true when things have started moving
var shouldSleep = false // This gets set to true once everything's slowed down enough
var activeObjects = []
// Setup a canvas for drawing UI elements onto
var uiCanvas = document.getElementById('ui')
uiCanvas.width = window.innerWidth
uiCanvas.height = window.innerHeight
var uiContext = uiCanvas.getContext('2d')
var canvas // We'll set this once we've started PhysicsJS and got a renderer
var edgeUid
// Setup HammerJS, the mouse/touch gesture library we'll use for the controls
var hammer = new Hammer(uiCanvas)
// HammerJS only listens for horizontal drags by default, here we tell it listen for all directions
hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL })

var messages = {
  'aiming-jump': 'Aim a jump by dragging in the opposite direction',
  'aiming-shot': 'Aim a shot by dragging in the opposite direction'
}

/*
 * Start PhysicsJS, which will also handle rendering for us. We run the game from inside this function
 */

Physics(function (world) {
  // create a renderer
  var renderer = Physics.renderer('canvas', {
    el: 'viewport',
    width: window.innerWidth,
    height: window.innerHeight
  })
  canvas = renderer.el

  // We'll add 10000 to the ceiling of the world, so that shots can arc off the top of the screen
  viewportBounds = Physics.aabb(0, -10000, window.innerWidth, window.innerHeight + 10000)

  // add the renderer to the world
  world.add(renderer)
  // render on each step
  world.on('step', function () {
    var sleeping = activeObjects.every(function (object) { return object.asleep })
    if (sleeping && game.currentTurn.actionsRemaining == 0) nextTurn(world)
    world.render()
  })

  // resize canvas when the browser is resized
  window.addEventListener('resize', function () {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    uiCanvas.width = window.innerWidth
    uiCanvas.height = window.innerHeight
    viewportBounds = Physics.aabb(0, 0, window.innerWidth, window.innerHeight)
  }, true)

  Physics.util.ticker.on(function (time) {
    drawUI()
    world.step(time)
  })

  // Make our terrain and add it to the world
  var terrain = genTerrain(canvas.height * 0.9, canvas.height * 0.23, world)
  world.add(terrain)
  // Add each of our characters to the world
  game.characters = getCharacters(world)
  game.characters.forEach(function (character) {
    activeObjects.push(character)
    world.add(character)
  })
  // Add gravity and collision detection
  // We need to remember the ID of the edge detection behaviour for use in the fireProjectile function
  var edgeBehaviour = Physics.behavior('edge-collision-detection', {
    aabb: viewportBounds,
    restitution: 0.99,
    cof: 0.8
  })
  edgeUid = edgeBehaviour.body.uid
  world.add([
    Physics.behavior('constant-acceleration'),
    Physics.behavior('body-impulse-response'),
    Physics.behavior('body-collision-detection'),
    Physics.behavior('sweep-prune'),
    edgeBehaviour
  ])

  Physics.util.ticker.start()
  setTimeout(function () {
    canSleep = true
  }, 500)
})

function makeCharacter (name, position, world) {
  console.log(name, position)
  // Return an object that describes our new character
  var body = Physics.body('circle', {
    x: position.x,
    y: position.y,
    radius: 5
  })
  body.treatment = 'dynamic'
  body.cof = 0.8
  body.restitution = 0
  body.mass = 0.00001
  body.view = new Image(20, 120)
  body.view.src = 'img/' + name + '.png'
  body.gameData = {
    name: name,
    health: 100,
    takeDamage: function (damage) {
      this.health = Math.round(this.health - damage)
      if (this.health <= 0) this.die()
    },
    die: function () {
      console.log('game over man')
      var self = this
      game.characters.forEach(function (char, index) {
        if (char.gameData == self) game.characters.pop(index)
      })
      game.deadCharacters.push(self)
      if (game.characters.length < 2) {
        console.log('game over man')
        endGame()
      }
    }
  }
  return body
}

function getCharacters (world) {
  var renderer = world.renderer()
  var chars = []
  chars.push(makeCharacter('player1', { x: canvas.width * 0.1, y: canvas.height * 0.3 }, world))
  chars.push(makeCharacter('player2', { x: canvas.width * 0.9, y: canvas.height * 0.3 }, world))
  return chars
}

function aim (world, callback) {
  // Start listening for the start of a mouse/finger drag
  /*
  * We're calling hammer.on three times here, to listen for three different types of events; 'panstart'
  * fires when the user starts to drag, 'pan' will fire every time the user drags their pointer on the 
  * canvas while their mouse or finger is pressed down, and 'panend' will fire once when they release. The 
  * second parameter passed to hammer.on parameter is the callback function that the input event is passed
  * to. Hammer will continue to listen and run these functions until we call hammer.off('pan') for each event 
  * to tell it to stop.
  */
  hammer.on('panstart', function (event) {
    // HammerJS tells us where the user started dragging relative to the page, not the canvas - translate here
    // We grab the position at the start of the drag and remember it to draw a nice arrow from
    var center = {
      x: event.center.x - uiCanvas.getBoundingClientRect().left,
      y: event.center.y - uiCanvas.getBoundingClientRect().top
    }
    hammer.on('pan', function (event) {
      // The distance of the drag is measured in pixels, so we have to standardise it before
      // translating it into the 'power' of our shot. You might want to console.log out event.angle
      // here to see how HammerJS gives us angles.
      var power = translateDistanceToPower(event.distance)
      game.aimArrow = {
        start: center,
        angle: event.angle,
        power: power
      }
    })
  })
  
  hammer.on('panend', function (event) {
    hammer.off('panstart pan panend')
    // The player has stopped dragging, let loose!
    var power = translateDistanceToPower(event.distance)
    callback(event.angle, power, world)
    game.aimArrow = null
    // Stop listening to input until the next turn
  })
}

function nextTurn (world) {
  // We take the last character from our array of characters and 'pop' it off - this is our current player
  var player = game.characters.pop()
  // We then put that character back at the start of the array, using the bizarrely-named 'unshift'
  game.characters.unshift(player)

  game.currentTurn.actionsRemaining = 3
  game.currentTurn.state = 'aiming-jump'
  aim(world, function (angle, power, world) {
    jump(angle, power, world, function (world) {
      game.currentTurn.state = 'aiming-shot'
      aim(world, function (angle, power, world) {
        fireProjectile(angle, power, world)
      })
    })
  })
}

function jump (angle, power, world, callback) {
  world.wakeUpAll()
  canSleep = false
  setTimeout(function () { canSleep = true }, 500)
  var player = game.characters[0]
  game.currentTurn.actionsRemaining--
  game.currentTurn.state = 'jumping'
  var radians = angle * Math.PI / 180
  var stepX = (power * Math.cos(radians)) / 130000000
  var stepY = (power * Math.sin(radians)) / 130000000
  game.characters.forEach(function (char) { char.treatment = 'static' })
  player.treatment = 'dynamic'
  world.unpause()
  player.applyForce({ x: -stepX, y: -stepY })
  console.log(player, stepX, stepY)
  activeObjects.push(player)
  callback(world)
}

function fireProjectile (angle, power, world) {
  canSleep = false
  setTimeout(function () { canSleep = true }, 500)
  var player = game.characters[0]
  game.currentTurn.actionsRemaining--
  game.currentTurn.state = 'firing'
  // We use the angle to work out how many pixels we should move the projectile each frame
  var radians = angle * Math.PI / 180
  var stepX = (power * Math.cos(radians)) / 8000
  var stepY = (power * Math.sin(radians)) / 8000
  var projectile = Physics.body('circle', {
    x: player.state.pos.x - stepX,
    y: player.state.pos.y - 60 - stepY,
    radius: 4,
    styles: {
      strokeStyle: 'white',
      fillStyle: 'white',
      lineWidth: 4
    }
  })
  projectile.restitution = 0.5
  projectile.cof = 0.1
  projectile.mass = 0.1
  projectile.applyForce({ x: -stepX, y: -stepY })

  world.add(projectile)
  game.characters.forEach(function (char) { char.treatment = 'static' })
  activeObjects.push(projectile)
  world.unpause()

  world.on('collisions:detected', function (data) {
    data.collisions.forEach(function (collision) {
      var impactedProjectile
      if (collision.bodyA.uid == projectile.uid) impactedProjectile = collision.bodyA
      if (collision.bodyB.uid == projectile.uid) impactedProjectile = collision.bodyB
      
      if (impactedProjectile) {
        if (collision.bodyA.uid == edgeUid || collision.bodyB.uid == edgeUid) {
          impactProjectile(impactedProjectile, 0, 0, world)
        } else {
          impactProjectile(impactedProjectile, 100, 0.5, world)
        }
      }
    })
  })
}

function translateDistanceToPower (distance) {
  // Divide the height of the canvas by the distance of our drag - we'll set a 'power limit' of 50% screen height
  var power = distance / canvas.height
  if (power > 0.5) power = 0.5
  // The maths are easier if our 'max power' is 100
  power = power * 200
  return power
}

function drawPlayerMarker (player) {
  // Get the position of the player and draw a lil white triangle above it
  uiContext.beginPath()
  uiContext.moveTo(player.state.pos.x, player.state.pos.y - 70)
  uiContext.lineTo(player.state.pos.x - 10, player.state.pos.y - 90)
  uiContext.lineTo(player.state.pos.x + 10, player.state.pos.y - 90)
  uiContext.closePath()
  uiContext.fillStyle = 'white'
  uiContext.fill()
}

function drawUI () {
  uiContext.clearRect(0, 0, uiCanvas.width, uiCanvas.height)
  drawPlayerMarker(game.characters[0])
  // Draw any ongoing explosions
  game.explosions.forEach(function (explosion, i) {
    if (explosion.size >= explosion.maxSize) game.explosions.splice(i, 1)
    uiContext.beginPath()
    uiContext.arc(explosion.position.x, explosion.position.y, explosion.size, 0, Math.PI * 2, false)
    uiContext.lineWidth = 4
    uiContext.strokeStyle = '#E9FA8F'
    uiContext.stroke()
    explosion.size += explosion.size * 0.3
  })

  if (game.aimArrow) {
    // Do some maths I copied from the internet
    var radians = game.aimArrow.angle * Math.PI / 180
    var arrowToX = game.aimArrow.start.x - game.aimArrow.power * Math.cos(radians)
    var arrowToY = game.aimArrow.start.y - game.aimArrow.power * Math.sin(radians)
    // Draw the line
    uiContext.moveTo(game.aimArrow.start.x, game.aimArrow.start.y)
    uiContext.lineTo(arrowToX, arrowToY)
    uiContext.strokeStyle = 'white'
    uiContext.lineWidth = 1
    uiContext.stroke()
  }

  uiContext.fillStyle = 'white'
  var messageText = messages[game.currentTurn.state]
  if (messageText) uiContext.fillText(messageText, canvas.width - 30 - (uiContext.measureText(messageText).width), 40)

  if (game.characters.length == 1) {
    var winner = game.characters[0]
    uiContext.fillStyle = 'white'
    var text = '> '+ winner.colour +' player == "champion"'
    uiContext.fillText(text, canvas.width / 2 - (uiContext.measureText(text).width / 2), canvas.height / 2 - 20)
    uiContext.fillText('true', canvas.width / 2 - (uiContext.measureText(text).width / 2), canvas.height / 2 + 20)
  } else {
    var i = 1
    game.characters.forEach(function (char) {
      if (i == 1) uiContext.fillStyle = 'green'
      else uiContext.fillStyle = 'white'
      uiContext.font = '20px courier'
      var text = char.gameData.name + ': ' + char.gameData.health
      uiContext.fillText(text, 30, i * 40)
      i++
    })
  }
}

function impactProjectile (projectile, explosionSize, damageFactor, world) {
  game.explosions.push({
    position: projectile.state.pos,
    maxSize: explosionSize,
    size: 1
  })

  game.characters.forEach(function (char) {
    var distance = Math.sqrt(Math.pow((char.state.pos.x - projectile.state.pos.x), 2) + Math.pow((char.state.pos.y - projectile.state.pos.y), 2))
    var angle = Math.atan2(char.state.pos.y - projectile.state.pos.y, char.state.pos.x - projectile.state.pos.x)
    if (distance < explosionSize) {
      char.gameData.takeDamage((explosionSize - distance) * damageFactor)
    }
  })

  world.removeBody(projectile)
  activeObjects.forEach(function (object, i) {
    if (object.uid == projectile.uid) activeObjects.splice(i, 1)
  })
  game.currentTurn.actionsRemaining--
  nextTurn(world)
}

function endGame () {
  // drawUI checks the length of the characters array and displays game over, so we just render
  console.log('game over man...')
}

function genTerrain (floor, height, world) {
  var renderer = world.renderer()
  var xPoints = []
  var yPoints = []
  // Get a number between 5 and 15. This will be the number of angles along our line
  var numberOfPoints = Math.round(10 + (Math.random() * 20))
  // Loop over this number, generating a number at least as high as 'floor' and as large as 'floor + height'
  // These will represent the height of the peaks and valleys of our terrain
  for (var i = 0; i < numberOfPoints; i++) {
    var point = floor + (Math.random() * height)
    yPoints.push(point)
  }
  // We do something similar again to decide how far apart these points are on the X axis, adding the previous value to
  // each new random number so we get an increasing list of numbers with random gaps between them
  for (var i = 0; i < numberOfPoints; i++) {
    if (i > 0) var point = xPoints[i - 1] + 10 + (Math.random() * 100)
    else var point = 10 + (Math.random() * 100)
    xPoints.push(point)
  }
  // However, we now have a range of points on the X axis that may be larger than the width of our screen, so we squash them down
  // Get the last point and divide it by the screen width, then multiply all points by this number
  var squashFactor = canvas.width / (xPoints[xPoints.length - 1] / 2)

  var compoundShape = Physics.body('compound', {
    x: 0,
    y: 0,
    treatment: 'static',
    styles: {
      fillStyle: '#FFFFFF',
      strokeStyle: '#FFFFFF',
      lineWidth: 3
    }
  })
  // Array.map() is a neato functional way of turning an array into another array
  // We're looping through our array and making a new array of vector objects
  var terrainVertices = xPoints.map(function (xPoint, i) {
    var globalCoords = {
      x: Math.round(xPoint * squashFactor),
      y: Math.round(canvas.height - yPoints[i])
    }
    return compoundShape.toBodyCoords(new Physics.vector(globalCoords))
  })
  // We'll stretch the shape out way beyond the edges of the screen to be safe
  var topRightCorner = compoundShape.toBodyCoords(new Physics.vector({
    x: canvas.width + 10000,
    y: terrainVertices[terrainVertices.length - 1].y
  }))
  var bottomRightCorner = compoundShape.toBodyCoords(new Physics.vector({
    x: canvas.width + 10000,
    y: canvas.height
  }))
  var bottomLeftCorner = compoundShape.toBodyCoords(new Physics.vector({
    x: -10000,
    y: canvas.height
  }))
   var topLeftCorner = compoundShape.toBodyCoords(new Physics.vector({
    x: -10000,
    y: terrainVertices[0].y
  }))
  terrainVertices.push(topRightCorner)
  terrainVertices.push(bottomRightCorner)
  terrainVertices.push(bottomLeftCorner)
  terrainVertices.push(topLeftCorner)
  // If you console.log(terrainVertices) here, you'll see that we have a list of coordinates describing our terrain
  // Now, because PhysicsJS doesn't support concave polygons, we have to turn this into a bunch of connected rectangles
  terrainVertices.forEach(function (vertex, i) {
    var nextVertex = terrainVertices[i+1]
    if (nextVertex == undefined) nextVertex = terrainVertices[0]
    // Bunch of maths I copied off stackoverflow to get the distance and angle (in radians) between this point and the next
    var distance = Math.sqrt(Math.pow((nextVertex.x - vertex.x), 2) + Math.pow((nextVertex.y - vertex.y), 2))
    var angle = Math.atan2(nextVertex.y - vertex.y, nextVertex.x - vertex.x)
    // We're making a rectangle as wide as 'distance', positioned and rotated to bridge the two points
    var rectangle = Physics.body('rectangle', {
      x: (vertex.x + nextVertex.x) / 2,
      y: (vertex.y + nextVertex.y) / 2,
      width: distance,
      height: 1,
      angle: angle
    })

    // var relativeCoords = compoundShape.toBodyCoords(new Physics.vector({ x: rectangle.state.pos.x, y: rectangle.state.pos.y }))
    compoundShape.addChild(rectangle)
  })
  compoundShape.state.pos.x = canvas.width * 2
  compoundShape.state.pos.y = canvas.height * 0.75
  return compoundShape
}

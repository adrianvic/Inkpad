//// THIS CODE AND INFORMATION IS PROVIDED "AS IS" WITHOUT WARRANTY OF
//// ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//// THE IMPLIED WARRANTIES OF MERCHANTABILITY AND/OR FITNESS FOR A
//// PARTICULAR PURPOSE.
////
//// Copyright (c) Microsoft Corporation. All rights reserved

// Sample app demonstrating the use of Ink and Reco APIs in the modern SDK.
// We are using Windows.UI.Input.Inking.InkManager.

function showMessage(message, isError)
{
    var status = document.getElementById("statusMessage");
    if (status)
    {
        status.innerText = message;
        status.style.color = isError ? "blue" : "green";
    }
}

function displayStatus(message)
{
    showMessage(message, false);
}

function displayError(message)
{
    showMessage(message, true);
}

// ISSUE: Uncomment-out this call to get status messages from handleSuspending and handleActivated
function displayDebug(message)
{
//    showMessage(message, false);
}

window.onerror = function (msg, url, line) {displayError("Error: " + msg + " url = " + url + " line = " + line);};

// Functions to convert from and to the 32-bit int used to represent color in Windows.UI.Input.Inking.InkManager.

// Convenience function used by color converters.
// Assumes arg num is a number (0..255); we convert it into a 2-digit hex string.

function byteHex(num)
{
    var hex = num.toString(16);
    if (hex.length === 1)
    {
        hex = "0" + hex;
    }
    return hex;
}

// Convert from Windows.UI.Input.Inking's color code to html's color hex string.
// Note the little-endian representation.
function toColorString(num)
{
    var R = (num & 0x0000FF);
    var G = (num & 0x00FF00) >> 8;
    var B = (num & 0xFF0000) >> 16;
    var str = "#" + byteHex(R) + byteHex(G) + byteHex(B);
    return str;
}

// Convert from the few color names used in this app to Windows.UI.Input.Inking's color code.
// If it isn't one of those, then decode the hex string.  Otherwise return gray.
// This does not include any alpha component.
// Note the little-endian representation.
function toColorInt(color)
{
    switch (color)
    {
    // Ink colors
    case "Black":
        return 0x000000;
    case "Blue":
        return 0xFF0000;
    case "Red":
        return 0x0000FF;
    case "Green":
        return 0x008000;

    // Highlighting colors
    case "Yellow":
        return 0x00FFFF;
    case "Aqua":
        return 0xFFFF00;
    case "Lime":
        return 0x00FF00;

    // Select colors
    case "Gold":
        return 0x00D7FF;

    case "White":
        return 0xFFFFFF;
    }

    if ((color.length === 7) && (color.charAt(0) === "#"))
    {
        var R = parseInt(color.substr(1, 2), 16);
        var G = parseInt(color.substr(3, 2), 16);
        var B = parseInt(color.substr(5, 2), 16);
        return (B << 16) + (G << 8) + R;
    }

    return 0x808080; // Gray
}

// Global variables representing the ink interface.
// The usage of a global variable for drawingAttributes is not completely necessary,
// just a convenience.  One could always re-fetch the current drawingAttributes
// from the inkManager.
var inkManager = new Windows.UI.Input.Inking.InkManager();
var drawingAttributes = new Windows.UI.Input.Inking.InkDrawingAttributes();
drawingAttributes.fitToCurve = true;
drawingAttributes.alpha = 255;
inkManager.setDefaultDrawingAttributes(drawingAttributes);

// These are the global canvases (and their 2D contexts) for highlighting, for drawing ink,
// and for lassoing (and erasing).
var hlCanvas;
var hlContext;
var inkCanvas;
var inkContext;
var selCanvas;
var selContext;

// The "mode" of whether we are highlighting, inking, lassoing, or erasing is controlled by this global variable,
// which should be pointing to either hlContext, inkContext, or selContext.
// In lassoing mode (when context points to selContext), we might also be in erasing mode;
// the state of lassoing vs. erasing is kept inside the ink manager, in attribute "mode", which will
// have a value from enum Windows.UI.Input.Inking.InkManipulationMode, one of either "selecting"
// or "erasing" (the other value being "inking" but in that case context will be pointing to one of the other
// 2 canvases).
var context;

// Three functions to save and restore the current mode, and to clear this state.

// Note that we can get into erasing mode in one of two ways: there is a eraser button in the toolbar,
// and some pens have an active back end that is meant to represent erasing.  If we get into erasing
// mode via the button, we stay in that mode until another button is pushed.  If we get into erasing
// mode via the eraser end of the stylus, we should switch out of it when the user switches to the ink
// end of the stylus.  And we want to return to the mode we were in before this happened.  Thus we
// maintain a shallow stack (depth 1) of "mode" info.

var savedContext = null;
var savedStyle = null;
var savedMode = null;

function clearMode()
{
    savedContext = null;
    savedStyle = null;
    savedMode = null;
}

function saveMode()
{
    if (!savedContext)
    {
        savedStyle = context.strokeStyle;
        savedContext = context;
        savedMode = inkManager.mode;
    }
}

function restoreMode()
{
    if (savedContext)
    {
        context = savedContext;
        context.strokeStyle = savedStyle;
        inkManager.mode = savedMode;
        clearMode();
    }
}

// Global variable representing the pattern used when in select mode.  This is an 8*1 image with 4 bits set,
// then 4 bits cleared, to give us a dashed line when drawing a lasso.
var selPattern;

// Global variable representing the application toolbar at the bottom of the screen.
var appbar;

// Global pointers to the find, and ink and highlight colors and widths, flyouts.
var findFlyout;
var inkColorsFlyout;
var inkWidthsFlyout;
var hlColorsFlyout;
var hlWidthsFlyout;

// Global pointer to the "More" button's flyout.  The "More" button shows as an ellipsis in the toolbar.
var moreFlyout;

// Global pointer to the dialog box used for displaying recognition results (top 5 alternates),
// and an array of buttons (one per alternate).  Note that while we think of it as a dialog box,
// it is really an html form.
var recoFlyout;
var clipButtons;

// Global pointer to the text buffer inside the Find flyout.
var findText;

// Returns true if any strokes inside the ink manager are selected; false otherwise.
function anySelected()
{
    var strokes = inkManager.getStrokes();
    var len = strokes.length;
    for (var i = 0; i < len; i++)
    {
        if (strokes[i].selected)
        {
            return true;
        }
    }
    return false;
}

//Returns true if this stroke is a highlighting stroke.
function isHighlighting(stroke)
{
    var att = stroke.drawingAttributes;
    return att.alpha < 200;
}

// Makes all strokes a part of the selection.
function selectAll()
{
    var strokes = inkManager.getStrokes();
    var len = strokes.length;
    for (var i = 0; i < len; i++)
    {
        strokes[i].selected = 1;
    }
}

// Makes all non-highlight strokes a part of the selection.
function selectAllNoHighlight()
{
    var strokes = inkManager.getStrokes();
    var len = strokes.length;
    for (var i = 0; i < len; i++)
    {
        if (!isHighlighting(strokes[i]))
        {
            strokes[i].selected = 1;
        }
    }
}

// Unselects any strokes which are highlighting.
function unselectHighlight()
{
    var strokes = inkManager.getStrokes();
    var len = strokes.length;
    for (var i = 0; i < len; i++)
    {
        if (strokes[i].selected && isHighlighting(strokes[i]))
        {
            strokes[i].selected = 0;
        }
    }
}

// Returns true if the point represented by x,y is within the rect.
function inRect(x, y, rect)
{
    return ((rect.x <= x) && (x < (rect.x + rect.width)) &&
             (rect.y <= y) && (y < (rect.y + rect.height)));
}

// Tests the array of results bounding boxes (from the recognition results on the ink manager).
// If a hit is found, select that ink (otherwise make sure no strokes are selected).
// Returns an object representing the results, with the original touch coordinates, the bounding
// box, the index of the result, the array of strokes in that specific word, and the array of alternates (recognition strings).

// If the touch is outside of any ink bounding box, then returns null.
function hitTest(tx, ty)
{
    var results = inkManager.getRecognitionResults();
    var cWords = results.size;

    // This will unselect any current selection.
    var pt = {x:0.0, y:0.0};
    inkManager.selectWithLine(pt, pt); 

    for (var i = 0; i < cWords; i++)
    {
        var rect = results[i].boundingRect;
        if (inRect(tx, ty, rect))
        {
            var strokes = results[i].getStrokes();
            var cStrokes = strokes.size;
            for (var j = 0; j < cStrokes; j++)
            {
                strokes[j].selected = true;
            }

            return {index: i,
                    handleX: tx,  // Original touch point
                    handleY: ty,
                    strokes: strokes,
                    rect: rect,
                    alternates: results[i].getTextCandidates()};
        }
    }

    return null;
}

// Note that we cannot just set the width in stroke.drawingAttributes.size.width,
// or the color in stroke.drawingAttributes.color.
// The stroke API supports get and put operations for drawingAttributes,
// but we must execute those operations separately, and change any values
// inside drawingAttributes between those operations.

// Change the color and width in the default (used for new strokes) to the values
// currently set in the current context.
function setDefaults()
{
    var strokeSize = drawingAttributes.size;
    strokeSize.width = strokeSize.height = context.lineWidth;
    drawingAttributes.size = strokeSize;

    drawingAttributes.color = toColorInt(context.strokeStyle);
    drawingAttributes.alpha = (context === hlContext) ? 128 : 255;
    inkManager.setDefaultDrawingAttributes(drawingAttributes);
}

// Four functions to switch back and forth between ink mode, highlight mode, select mode, and erase mode.
// There is also a temp erase mode, which uses the saveMode()/restoreMode() functions to
// return us to our previous mode when done erasing.  This is used for quick erasers using the back end
// of the pen (for those pens that have that).
// NOTE: The erase modes also attempt to set the mouse/pen cursor to the image of a chalkboard eraser
// (stored in images/erase.cur), but as of this writing cursor switching is not working.

function highlightMode()
{
    clearMode();
    context = hlContext;
    inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
    setDefaults();
    selCanvas.style.cursor = "default";
}

function inkMode()
{
    clearMode();
    context = inkContext;
    inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
    setDefaults();
    selCanvas.style.cursor = "default";
}

function selectMode()
{
    clearMode();
    selContext.strokeStyle = selPattern;
    context = selContext;
    inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.selecting;
}

function eraseMode()
{
    clearMode();
    selContext.strokeStyle = "rgba(255,255,255,0.0)";
    context = selContext;
    inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
    selCanvas.style.cursor = "url(images/erase.cur), auto";
}

function tempEraseMode()
{
    saveMode();
    selContext.strokeStyle = "rgba(255,255,255,0.0)";
    context = selContext;
    inkManager.mode = inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
    selCanvas.style.cursor = "url(images/erase.cur), auto";
}

// Set the width of a stroke.  Return true if we actually changed it.
// Note that we cannot just set the width in stroke.drawingAttributes.size.width.
// The stroke API supports get and put operations for drawingAttributes,
// but we must execute those operations separately, and change any values
// inside drawingAttributes between those operations.
function shapeStroke(stroke, width)
{
    var att = stroke.drawingAttributes;
    var strokeSize = att.size;
    if (strokeSize.width !== width)
    {
        strokeSize.width = strokeSize.height = width;
        att.size = strokeSize;
        stroke.drawingAttributes = att;
        return true;
    }
    else
    {
        return false;
    }
}

// Set the color (and alpha) of a stroke.  Return true if we actually changed it.
// Note that we cannot just set the color in stroke.drawingAttributes.color.
// The stroke API supports get and put operations for drawingAttributes,
// but we must execute those operations separately, and change any values
// inside drawingAttributes between those operations.
function colorStroke(stroke, color)
{
    var att = stroke.drawingAttributes;
    var code = toColorInt(color);
    if (att.color !== code)
    {
        att.color = code;
        stroke.drawingAttributes = att;
        return true;
    }
    else
    {
        return false;
    }
}

// Global memory of the current pointID (for pen, and, separately, for touch).
// We ignore handlePointerMove() and handlePointerUp() calls that don't use the same
// pointID as the most recent handlePointerDown() call.  This is because the user sometimes
// accidentally nudges the mouse while inking or touching.  This can cause move events
// for that mouse that have different x,y coordinates than the ink trace or touch path
// we are currently handling.

// MSPointer* events maintain this pointId so that one can track individual fingers,
// the pen, and the mouse.

// Note that when the pen fails to leave the area where it can be sensed, it does NOT
// get a new ID; so it is possible for 2 or more consecutive strokes to have the same ID.

var penID = -1;
var touchID = -1;

// If we have touched the screen, the details will be inside global variable touchedResults.
// If we touched inside a recognized word, additional details about that word will be included.
// See hitTest() above.
var touchedResults = null;

// In pointer handlers, evt.pointerType will be one of these values:
// 2	Touch
// 3	Pen
// 4	Mouse

// We will accept pen down or mouse left down as the start of a stroke.
// We will accept touch down or mouse right down as the start of a touch.
function handlePointerDown(evt)
{
    try
    {
        if ((evt.pointerType === 3) || ((evt.pointerType === 4) && (evt.button === 1)))
        {
            evt.preventManipulation();
            var pt = evt.currentPoint;

            if (pt.properties.isEraser) // the back side of a pen, which we treat as an eraser
            {
                tempEraseMode();
            }
            else
            {
                restoreMode();
            }

            if (inkManager.mode === Windows.UI.Input.Inking.InkManipulationMode.inking)
            {
                // Unselect all strokes.
                var origin = {x:0.0, y:0.0};
                inkManager.selectWithLine(origin, origin); 
            }

            context.beginPath();
            context.moveTo(pt.rawPosition.x, pt.rawPosition.y);

            inkManager.processPointerDown(pt);
            penID = evt.pointerId;
        }
        else if ((evt.pointerType === 2) || ((evt.pointerType === 4) && (evt.button === 2)))
        {
            // ISSUE: Optionally, one could remember the selected strokes in a global,
            // before selecting the touched strokes (or all strokes), so that they can be restored after the move/pan.
            touchedResults = hitTest(evt.offsetX, evt.offsetY);
            if (touchedResults)
            {
                evt.preventManipulation();
                touchID = evt.pointerId;
            }
        }
    }
    catch (e)
    {
        displayError("handlePointerDown " + e.toString());
    }
}

function handlePointerMove(evt)
{
    try
    {
        var pt = evt.currentPoint;
        if (evt.pointerId === penID)
        {
            evt.preventManipulation();
            context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
            context.stroke();
            // Get all the points we missed and feed them to inkManager.
            // The array pts includes (as the last one) the point in pt above (returned by evt.currentPoint).
//            var pts = evt.intermediatePoints;
//            var i;
//            for (i = 0; i < pts.length; i++)
//            {
//                inkManager.processPointerUpdate(pts[i]);
//            }
            inkManager.processPointerUpdate(pt);
        }
        else if (evt.pointerId === touchID)
        {
            if (touchedResults)
            {
                evt.preventManipulation();
                if ((touchedResults.x !== evt.offsetX) || (touchedResults.y !== evt.offsetY))
                {
                    var shift = {x: evt.offsetX - touchedResults.handleX, y: evt.offsetY - touchedResults.handleY};
                    inkManager.moveSelected(shift);
                    renderAllStrokes("suppress");
                    touchedResults.handleX = evt.offsetX;
                    touchedResults.handleY = evt.offsetY;
                }
            }
        }
    }
    catch (e)
    {
        displayError("handlePointerMove " + e.toString());
    }
}

function handlePointerUp(evt)
{
    try
    {
        var pt = evt.currentPoint;
        if (evt.pointerId === penID)
        {
            evt.preventManipulation();
            context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
            context.stroke();
            context.closePath();
            inkManager.processPointerUp(pt);
        }
        else if (evt.pointerId === touchID)
        {
            if (touchedResults)
            {
                evt.preventManipulation();
                if ((touchedResults.x !== evt.offsetX) || (touchedResults.y !== evt.offsetY))
                {
                    var shift = {x: pt.rawPosition.x - touchedResults.handleX, y: pt.rawPosition.y - touchedResults.handleY};
                    inkManager.moveSelected(shift);
                }
                // If we touched a single word, then either put up the recognitions (if we didn't move much),
                // or re-run the recognizer (if we did move substantially).
                if (inRect(pt.rawPosition.x, pt.rawPosition.y, touchedResults.rect))
                {
                    evt.preventDefault();
                    touchWord(touchedResults);
                }
                else
                {
                    recognize(evt);
                }
            }
        }
        touchedResults = null;
        touchID = -1;
        penID = -1;
        renderAllStrokes();
    }
    catch (e)
    {
        displayError("handlePointerUp " + e.toString());
    }
}

// We treat the event of the pen leaving the canvas as the same as the pen lifting;
// it completes the stroke.
function handlePointerOut(evt)
{
    try
    {
        if (evt.pointerId === penID)
        {
            evt.preventManipulation();
            var pt = evt.currentPoint;
            context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
            context.stroke();
            context.closePath();
            inkManager.processPointerUp(pt);
            touchedResults = null;
            touchID = -1;
            penID = -1;
            renderAllStrokes();
        }
    }
    catch (e)
    {
        displayError("handlePointerOut " + e.toString());
    }
}

//Draws a single stroke into a specified canvas 2D context, with a specified color and width.
function renderStroke(stroke, color, width, ctx)
{
    ctx.save();

    try
    {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;

        var first = true;
        stroke.getRenderingSegments().forEach(function (segment)
        {
            if (first)
            {
                ctx.moveTo(segment.position.x, segment.position.y);
                first = false;
            }
            else
            {
                ctx.bezierCurveTo(segment.bezierControlPoint1.x, segment.bezierControlPoint1.y,
                                  segment.bezierControlPoint2.x, segment.bezierControlPoint2.y,
                                  segment.position.x,            segment.position.y);
            }
        });

        ctx.stroke(); 
        ctx.closePath();

        ctx.restore();
    }
    catch (e)
    {
        ctx.restore();
        displayError("renderStroke " + e.toString());
    }
}

// This draws a basic notepaper pattern into the highlight canvas, which is the lowest canvas.
// It has a single vertical dark red line defining the left margin, and a series of horizontal blue lines.
function renderPaper()
{
    var height = hlCanvas.height;
    var bottom = height - 0.5;
    var right = hlCanvas.width - 0.5;

    hlContext.save();

    try
    {
        hlContext.beginPath();
        hlContext.strokeStyle = "FireBrick";
        hlContext.lineWidth = 1;
        hlContext.moveTo(120.5, 0.5);
        hlContext.lineTo(120.5, bottom);
        hlContext.stroke();
        hlContext.closePath();

        hlContext.beginPath();
        hlContext.strokeStyle = "Blue";
        hlContext.lineWidth = 1;
        for (var y = 65.5; y < height; y += 55)
        {
            hlContext.moveTo(0.5, y);
            hlContext.lineTo(right, y);
        }
        hlContext.stroke();
        hlContext.closePath();

        hlContext.restore();
    }
    catch(e)
    {
        hlContext.restore();
        displayError("renderPaper " + e.toString());
    }
}

// Redraws (from the beginning) all strokes in the canvases.  All canvases are erased,
// then the paper is drawn, then all the strokes are drawn.
// Selected strokes glow unless the arg "suppress" is passed.
function renderAllStrokes(suppress)
{
    var glow = !suppress || (suppress !== "suppress");

    selContext.clearRect(0, 0, selCanvas.width, selCanvas.height);
    inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
    hlContext.clearRect(0, 0, hlCanvas.width, hlCanvas.height);

    renderPaper();

    inkManager.getStrokes().forEach(function (stroke)
    {
        var att = stroke.drawingAttributes;
        var color = toColorString(att.color);
        var strokeSize = att.size;
        var width = strokeSize.width;
        var hl = isHighlighting(stroke);
        var ctx = hl ? hlContext : inkContext;
        if (glow && stroke.selected)
        {
            renderStroke(stroke, color, width * 2, ctx);
            var stripe = (hl ? "Azure" : "White");
            var w = width - (hl ? 3 : 1);
            renderStroke(stroke, stripe, w, ctx);
        }
        else
        {
            renderStroke(stroke, color, width, ctx);
        }
    });
}

function clear()
{
    try
    {
        WinJS.UI.getControl(moreFlyout).hide();
        if (anySelected())
        {
            inkManager.deleteSelected();
        }
        else
        {
            var strokeView = inkManager.getStrokes();
            var strokeViewSize = strokeView.size;
            for (var i = 0; i < strokeViewSize; i++)
            {
                var stroke = strokeView.getAt(i);
                stroke.selected = true;
            }
            inkManager.deleteSelected();
            inkMode();
        }

        renderAllStrokes();
        displayStatus("");
    }
    catch (e)
    {
        displayError("clear " + e.toString());
    }
}

// A button handler which fetches the value from the button, which should
// be a number.  We set the lineWidth of the inking canvas to this width,
// then set the system into ink mode (which will cause the ink manager
// to change its defaults for new strokes to match the ink canvas).
// If any ink strokes (not including highlight strokes) are currently selected,
// we also change their width to this value.  If any strokes are changed
// we must re-render the entire ink display.
function setInkWidth(evt)
{
    try
    {
        WinJS.UI.getControl(inkWidthsFlyout).hide();
        inkContext.lineWidth = evt.srcElement.value;
        inkMode();

        // Change any selected strokes to the new width.  If any strokes change,
        // we must also re-render all the strokes.
        var redraw = false;
        inkManager.getStrokes().forEach(function (stroke)
        {
            if (stroke.selected && !isHighlighting(stroke))
            {
                if (shapeStroke(stroke, inkContext.lineWidth))
                {
                    redraw = true;
                }
            }
        });
        if (redraw)
        {
            renderAllStrokes();
        }
    }
    catch (e)
    {
        displayError("setInkWidth " + e.toString());
    }
} 

// A button handler which fetches the value from the button, which should
// be a number.  We set the lineWidth of the highlight canvas to this width,
// then set the system into highlight mode (which will cause the ink manager
// to change its defaults for new strokes to match the highlight canvas).
// If any highlight strokes are currently selected, we also change their width
// to this value.  If any strokes are changed we must re-render the entire ink display.
function setHighlightWidth(evt)
{
    try
    {
        WinJS.UI.getControl(hlWidthsFlyout).hide();
        hlContext.lineWidth = evt.srcElement.value;
        highlightMode();

        // Change any selected strokes to the new width.  If any strokes change,
        // we must also re-render all the strokes.
        var redraw = false;
        inkManager.getStrokes().forEach(function (stroke)
        {
            if (stroke.selected && isHighlighting(stroke))
            {
                if (shapeStroke(stroke, hlContext.lineWidth))
                {
                    redraw = true;
                }
            }
        });
        if (redraw)
        {
            renderAllStrokes();
        }
    }
    catch (e)
    {
        displayError("setInkWidth " + e.toString());
    }
} 

// A button handler which fetches the value from the button, which should
// be a color name.  We set the strokeStyle of the inking canvas to this color,
// then set the system into ink mode (which will cause the ink manager
// to change its defaults for new strokes to match the ink canvas).
// If any ink strokes (not including highlight strokes) are currently selected,
// we also change their color to this value.  If any strokes are changed
// we must re-render the entire ink display.
function inkColor(evt)
{
    WinJS.UI.getControl(inkColorsFlyout).hide();
    inkContext.strokeStyle = evt.srcElement.id;
    inkMode();

    // Change any selected strokes to the new color.  If any strokes are selected,
    // we must also re-render all the strokes.
    var redraw = false;
    inkManager.getStrokes().forEach(function (stroke)
    {
        if (stroke.selected && !isHighlighting(stroke))
        {
            if (colorStroke(stroke, inkContext.strokeStyle))
            {
                redraw = true;
            }
        }
    });
    if (redraw)
    {
        renderAllStrokes();
    }
}

// A button handler which fetches the value from the button, which should
// be a color name.  We set the strokeStyle of the highlight canvas to this color,
// then set the system into highlight mode (which will cause the ink manager
// to change its defaults for new strokes to match the highlight canvas).
// If any highlight strokes are currently selected, we also change their color
// to this value.  If any strokes are changed we must re-render the entire ink display.
function highlightColor(evt)
{
    WinJS.UI.getControl(hlColorsFlyout).hide();
    hlContext.strokeStyle = evt.srcElement.id;
    highlightMode();

    // Change any selected high-lighting strokes to the new color.  If any strokes change,
    // we must also re-render all the strokes.
    var redraw = false;
    inkManager.getStrokes().forEach(function (stroke)
    {
        if (stroke.selected && isHighlighting(stroke))
        {
            if (colorStroke(stroke, hlContext.strokeStyle))
            {
                redraw = true;
            }
        }
    });
    if (redraw)
    {
        renderAllStrokes();
    }
}

// Finds a specific recognizer, and sets the inkManager's default to that recognizer.
// Returns true if successful.
function setRecognizerByName(name)
{
    try
    {
        // recognizerView is a normal JavaScript array.
        var recognizerView = inkManager.getRecognizers();
        for (var i = 0, len = recognizerView.length; i < len; i++)
        {
            if (name === recognizerView[i].name)
            {
                inkManager.setDefaultRecognizer(recognizerView[i]);
                return true;
            }
        }
    }
    catch (e)
    {
        displayError("setRecognizerByName " + e.toString());
    }
    return false;
}

// A button handler which runs the currently-loaded handwriting recognizer over
// the selected ink (not counting highlight strokes).  If no ink is selected, then it
// runs over all the ink (again, not counting highlight strokes).
// The recogntion results (a string) is displayed in the status window.
// The recognitino results are also stored within the ink manager itself, so that
// other commands can find the bounding boxes (or ink strokes) of any specific
// word of ink.
function recognize(evt)
{
    try
    {
        var strokes = inkManager.getStrokes();
        if (strokes.length === 0)
        {
            displayStatus("Must first write something");
            return;
        }

        // The recognizeAsync() method has 3 modes: selected, remaining, and all.
        // This particular app cannot use "all" mode because it supports highlighting.
        // If the user has highlighted one or more words, and we recognize in "all" mode,
        // we will recognize all strokes, including the highlight strokes.  This usually
        // results in a recognition string containing many asterisks.
        // If we find that no strokes are selected, rather than running in "all" mode, we
        // select all strokes that are not highlighting strokes, then run in "selected" mode.
        // If some strokes were already selected, we just need to unselect any which are highlighting.

        // If we DID originally find that no strokes were selected, we remember that fact, so that
        // we can unselect them after the recognition.
        var bSelected = false;
        if (anySelected())
        {
            unselectHighlight();
        }
        else
        {
            selectAllNoHighlight();
            bSelected = true;
        }

        // Note that the third mode in recognizeAsync(), "recent", can be very useful in certain situations,
        // but we are not using it here.  It will recognize all strokes that have been added since the last
        // recognition.  If we were assuming that all strokes were writing, and we were trying to keep
        // recognition caught up with the user's writing at all times (that is, not using a Reco button),
        // then "recent" would be the mode we would want.

        // Because recognition is slower, we ask for it as an asynchronous operation.
        // The anonymous function (the first arg to the "then" method) will be called
        // as a callback when recognition has completed.  If an error occurs, the second
        // arg will be called.
        inkManager.recognizeAsync(Windows.UI.Input.Inking.InkRecognitionTarget.selected).then
        (
            function (results)
            {
                // Doing a recognition does not update the storage of results (the results that are stored inside the ink manager).
                // We do that ourselves by calling this method.
                inkManager.updateRecognitionResults(results);

                // The arg "results" is an array of result objects representing "words", where "words" means words of ink (not computer memory words).
                // IE, if you write "this is a test" that is 4 words, and results will be an array of length 4.
                // var resultsCount = results.size;

                var alternates = ""; // will accumulate the result words, with spaces between
                results.forEach(function (recognitionResult) // iterate over the words of ink
                {
                    // Method getTextCandidates() returns an array of recognition alternates (different interpretations of the same word of ink).
                    // For this program we only use the first (top) alternate in our display.
                    // If we were doing search over this ink, we would want to search all alternates.
                    var alternateStringArray = recognitionResult.getTextCandidates();
                    alternates = alternates + " " + alternateStringArray[0];

                    // The specific strokes forming the current word of ink are available to us.
                    // This feature is not used here, but we could, if we chose, display the ink,
                    // with the recognition result for each word directly above the specific word of ink,
                    // by fetching the bounding box of the recognitionResult (via the boundingRect property).
                    // Or, if we needed to do something to each stroke in the recognized word, we could
                    // call recognitionResult.getStrokes(), then iterate over the individual strokes.
                });//end recognitionResultView.forEach
                displayStatus(alternates);
            },
            function (e)
            {
                 displayError("InkManager::recognizeAsync " + e.toString());
            }
        );
        if (bSelected)
        {
            // Unselect all strokes (if we originally had no selected strokes).
            var pt = {x:0.0, y:0.0};
            inkManager.selectWithLine(pt, pt); 
        }
    }
    catch (e)
    {
        displayError("recognize: " + e.toString());
    }
}

// A utility function for findText() below.  This takes a target string (typed in by the user)
// an an array of recognition results objects, and inspects the recognition alternates of each
// results object.  If a match is found among the alternates, then all strokes in that results
// object are selected.
function findWord(target, results)
{
    try
    {
        var cWords = results.size;

        var count = 0;
        for (var i = 0; i < cWords; i++)
        {
            var alternates = results[i].getTextCandidates();
            var cAlts = alternates.size;
            for (var j = 0; j < cAlts; j++)
            {
                if (alternates[j].toLowerCase() === target.toLowerCase())
                {
                    var strokes = results[i].getStrokes();
                    var cStrokes = strokes.size;
                    for (var k = 0; k < cStrokes; k++)
                    {
                        strokes[k].selected = true;
                    }
                    count++;
                    break;
                }
            }
        }
        return count;
    }
    catch (e)
    {
        displayError("findWord: " + e.toString());
    }
}

// A handler for the Find button in the Find flyout.  We fetch the search string
// from the form, and the array of recognition results objects from the ink
// manager.  We unselect any current selection, so that when we are done
// the selections will reflect the search results.  We split the search string into
// individual words, since our recognition results objects each represent individual
// words.  The actual matching is done by findWord(), defined above.

// Note that multiple instances of a target can be found; if the target is "this" and
// the ink contains "this is this is that", 2 instances of "this" will be found and all
// strokes in both words will be selected.

// Note that findWord() above searches all alternates.  This means you might write
// "this", have it mis-recognized as "these", but the search feature MAY find it, if
// "this" appears in any of the other 4 recognition alternates for this ink.
function find(evt)
{
    try
    {
        WinJS.UI.getControl(findFlyout).hide();

        var str = findText.value;
        var results = inkManager.getRecognitionResults();

        // This will unselect any current selection.
        var pt = {x:0.0, y:0.0};
        inkManager.selectWithLine(pt, pt); 

        var count = 0;
        var words = str.split(" ");
        for (var i = 0; i < words.length; i++)
        {
            count += findWord(words[i], results);
        }

        if (0 < count)
        {
            displayStatus("Found " + count + " words");
            renderAllStrokes();
        }
        else
        {
            displayStatus("Did not find " + str);
        }
        return false;
    }
    catch (e)
    {
        displayError("find: " + e.toString());
    }
    return false;
}

// A form submit handler for recognition results buttons in the "reco" dialog box.
// The "reco" dialog box shows the top 5 recognition results for a specific word, and
// is invoked by tapping likely on a word (after recognition has been run).
// The top 5 results are actually submit buttons in this dialog box.
// We fetch the recognition result (the value of the submit button, a string) and
// copy it to the clipboard.
function recoClipboard(evt)
{
    try
    {
        WinJS.UI.getControl(recoFlyout).hide();
        var word = evt.srcElement.innerHTML;
        
        var dataPackage = new Windows.ApplicationModel.DataTransfer.DataPackage();
        dataPackage.setText(word);
        Windows.ApplicationModel.DataTransfer.Clipboard.setContent(dataPackage);
        displayStatus("To clipboard: " + word);
    }
    catch (e)
    {
        displayError("recoClipboard " + e.toString());
    }
}

// Brings up the "reco" dialog box, after first changing the values of the 5 submit buttons to be
// the top 5 recognition alternates of a single word.
function touchWord(touchedResults)
{
    try
    {
        // The Windows.UI.Input.Inking.InkManager interface normally returns 5 alternates.
        // We check just to be sure we are not given more alternates than the count of buttons.
        var cAlts = touchedResults.alternates.size;
        if (cAlts == 0)
        {
            return;
        }
        var cButs = clipButtons.length;
        if (cButs < cAlts)
        {
            cAlts = cButs;
        }
        var i;
        for (i = 0; i < cAlts; i++)
        {
            clipButtons[i].innerHTML = touchedResults.alternates[i];
        }
        for (; i < cButs; i++)
        {
            clipButtons[i].innerHTML = "";
        }

        // Compute a location for the reco results dialog box that will be just to the left of the left-top corner of the bounding rect of the ink.
        // If the x value goes negative, move it up to 0 (and let it cover the ink if need be).
        // If the y value would cause the bottom to go off the bottom of the screen, move it down (in value, or up in y).
        // Note how we use the dialog's (form's) clientWidth, not its style.width; this gives us the output of the live computation of the form's size.
        // And we compute the limit (to avoid going off the bottom of the screen) using window.innerHeight - recoFlyout.offsetHeight.
        // We use window.innerHeight, and not document.body.offsetHeight (or clientHeight) because the body height does not include
        // the fixed-position items (the canvases).

        var wordLeft = touchedResults.rect.x;
        var wordTop = touchedResults.rect.y;

        wordTop += selCanvas.offsetTop;
        var limit = window.innerHeight - recoFlyout.offsetHeight - 2;
        if (limit < wordTop)
        {
            wordTop = limit;
        }
        wordLeft -= (recoFlyout.offsetWidth + 40);
        if (wordLeft < 0)
        {
            wordLeft = 0;
        }

        recoFlyout.style.left = wordLeft + "px";
        recoFlyout.style.top = wordTop + "px";
        setTimeout(function() {WinJS.UI.getControl(recoFlyout).show();}, 1);
    }
    catch (e)
    {
        displayError("touchWord: " + e.toString());
    }
}

// A button handler which copies the selected strokes (or all the strokes if none are selected)
// into the clipboard.  The strokes can be pasted into any application that handles any of the
// ink clipboard formats, such as Windows Journal.
function copySelected(evt)
{
    try
    {
        WinJS.UI.getControl(moreFlyout).hide();
        if (anySelected())
        {
            displayStatus("Copying selected strokes ...");
            inkManager.copySelectedToClipboard();
            displayStatus("Copy Selected");
        }
        else
        {
            displayStatus("Copying all strokes ...");
            selectAll();
            inkManager.copySelectedToClipboard();
            // Unselect all strokes.
            var pt = {x:0.0, y:0.0};
            inkManager.selectWithLine(pt, pt); 
            displayStatus("Copy All");
        }
    }
    catch (e)
    {
        displayError("touchWord: " + e.toString());
    }
}

// A button handler which copies any available strokes in the clipboard into this app.
function paste(evt)
{
    WinJS.UI.getControl(moreFlyout).hide();

    displayStatus("Pasting ...");
    var insertionPoint = {x: 100, y: 60};
    var canPaste = inkManager.canPasteFromClipboard();
    if (canPaste)
    {
        inkManager.pasteFromClipboard(insertionPoint);
        displayStatus("Pasted");
        renderAllStrokes();
    }
    else
    {
        displayStatus("Cannot paste");
    }
}

// A button handler which closes the program.
function closeProgram(evt)
{
    displayStatus("Closing App ...");
    window.close();
}

function readInk(file)
{
    if (file)
    {
        file.openAsync(Windows.Storage.FileAccessMode.read).then
        (
            function(file)
            {
                var inputStream = file.getInputStreamAt(0);
                inkManager.load(inputStream);
                var strokeView = inkManager.getStrokes();
                var c = strokeView.size;
                displayStatus("Loaded " + c + " strokes.");
                renderAllStrokes();
            },
            function(e)
            {
                displayError("file::openAsync " + e.toString());
            }
        );
    }
}

function load(evt)
{
    try
    {
        WinJS.UI.getControl(moreFlyout).hide();

        // Open the WinRT file picker, set the input folder, and set the input extension.
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        picker.suggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.picturesLibrary;
        picker.fileTypeFilter.replaceAll([".gif"]);

        // Get the input file; file is of type Windows.Storage.StorageFile.
        picker.pickSingleFileAsync().then
        (
            readInk,
            function(e)
            {
                displayError("Picker::pickSingleFileAsync *.gif " + e.toString());
            }
        );
    }
    catch (e)
    {
        displayError("load " + e.toString());
    }
}

function writeInk(file)
{
    file.openAsync(Windows.Storage.FileAccessMode.readWrite).then
    (
        function(file)
        {
            var stream = file.getOutputStreamAt(0);
            inkManager.saveAsync(stream).then
            (
                function()
                {
                    stream.flushAsync().then
                    (
                        function()
                        {
                            GC.Collect();
                            // Print the size of the stream on the screen.
                            var size = stream.size;
                            displayStatus("Saved " + size.toString() + " bytes.");
                        },
                        function(e)
                        {
                             displayError("flushAsync " + e.toString());
                        }
                    );
                },
                function(e)
                {
                     displayError("saveAsync " + e.toString());
                }
            );
        },
        function(e)
        {
             displayError("openAsync " + e.toString());
        }
    );
}

function save(evt)
{
    try
    {
        WinJS.UI.getControl(moreFlyout).hide();

        var picker = new Windows.Storage.Pickers.FileSavePicker();
        picker.suggestedStartLocation = Windows.Storage.Pickers.PickerLocationId.picturesLibrary;
        picker.fileTypeChoices.insert("GIF file", [".gif"]);
        picker.defaultFileExtension = ".gif";
        picker.pickSaveFileAsync().then
        (
            writeInk,
            function(e)
            {
                 displayError("Windows::Storage::Picker::pickSaveFileAsync " + e.toString());
            }
        );
    }
    catch (e)
    {
        displayError("save " + e.toString());
    }
}

// A keypress handler that only handles a few keys.  This is registered on the entire body.
// Escape will:
//   1. If any dialog boxes are showing, hide them and do nothing else.
//   2. Otherwise, if any strokes are selected, unselect them and do nothing else.
//   3. Otherwise, change to ink mode.
// This sequence allows us to "unpeel the onion" (it is very fast to hit escape 3 times if needed).

// Certain control keys invoke handlers that are otherwise invoked via buttons:
//   ^C  Copy
//   ^V  Paste
//   ^F   Find
//   ^O   Load
//   ^S   Save
//   ^R   Recognize
//   ^Q   Quit (shuts down the sample app)

// Note that most of these keys have standardized normal uses, and there is system code to handle that
// without our code doing anything.  That code sometimes interferes with our program.  All the functions
// we call from here call evt.preventDefault(), which should stop the default processing, but sometimes we still
// cannot get this code to execute.
function keypress(evt)
{
    if (evt.keyCode === 27) // escape
    {
        evt.preventDefault();
        if (!WinJS.UI.getControl(recoFlyout).hidden)
        {
            WinJS.UI.getControl(recoFlyout).hide();
            renderAllStrokes();
        }
        else if (anySelected())
        {
            // Unselect all strokes.
            var pt = {x:0.0, y:0.0};
            inkManager.selectWithLine(pt, pt); 
            renderAllStrokes();
        }
        else
        {
            inkMode();
        }
    }
    else if (evt.keyCode === 3) // control c
    {
        copySelected(evt);
    }
    else if (evt.keyCode === 22) // control v
    {
        paste(evt);
    }
    else if (evt.keyCode === 15) // control o
    {
        load(evt);
    }
    else if (evt.keyCode === 19) // control s
    {
        save(evt);
    }
    else if (evt.keyCode === 18) // control r
    {
        recognize(evt);
    }
    else if (evt.keyCode === 17) // control q
    {
        closeProgram(evt);
    }
    else if (evt.keyCode === 1) // control a
    {
        displayDebug("SPY: button.hidden " + clipButtons[0].hidden + // property undefined
            " button.style.hidden " + clipButtons[0].style.hidden +    // property undefined
            " WinJS.UI.getControl(button).hidden " + WinJS.UI.getControl(clipButtons[0]).hidden +  // object is null or undefined
            " WinJS.UI.getControl(button).style.hidden " + WinJS.UI.getControl(clipButtons[0]).style.hidden);  // object is null or undefined
    }
}

var suspendFlags = {ink: false,
                    inkFile: false,
                    inkMode: false,
                    inkColor: false,
                    inkWidth: false,
                    highlightColor: false,
                    highlightWidth: false};

// Because there are asynchronous operations during suspension, we signal the need to handle suspension
// of the application asynchronously (by calling getDeferral()).  We then proclaim we are done by
// calling complete() on that deferral.
var deferral = null;
function checkDeferral()
{
    // After all asynchronous operations are done the app must call complete() on the deferral object;
    // otherwise the app will be terminated.
    if (suspendFlags.ink && suspendFlags.inkFile && suspendFlags.inkMode &&
        suspendFlags.inkColor && suspendFlags.inkWidth &&
        suspendFlags.highlightColor && suspendFlags.highlightWidth)
    {
        deferral.complete();
    }
}

function handleSuspending(eventArgs)
{
    displayDebug("handleSuspending");
    suspendFlags.ink = false;
    suspendFlags.inkFile = false;
    suspendFlags.inkMode = false;
    suspendFlags.inkColor = false;
    suspendFlags.inkWidth = false;
    suspendFlags.highlightColor = false;
    suspendFlags.highlightWidth = false;

    // We will be doing asynchronous operations during suspension, so we signal
    // the need to handle suspension of the application asynchronously.
    // We do this by via the getDeferral() method, and later call its complete() method.
    deferral = eventArgs.suspendingOperation.getDeferral();
    displayDebug("handleSuspending obtained deferral");

    // Obtain the inking mode.
    // Note that these if statements are structured such that if anything in our current state is
    // damaged, we will default to "inking".
    var inkMode = "inking";
    if (context === hlContext)
    {
        inkMode = "highlighting";
    }
    else if (context === selContext)
    {
        inkMode = "selecting";
        if (inkManager.mode === Windows.UI.Input.Inking.InkManipulationMode.erasing)
        {
            inkMode = "erasing";
        }
    }
    displayDebug("handleSuspending set inkMode to " + inkMode);

    // If there is no ink we do not write this file, and we set the inkFile.text to be the empty string.
    // Otherwise it contains the file name.
    var strokes = inkManager.getStrokes();
    var inkFile = "";
    if (0 < strokes.length)
    {
        var inkFile = "InkPad.suspend.gif";
        displayDebug("handleSuspending about to set saveCallback");
        // Note how these Async calls have no error function (second arg to then()).  If there are any errors we don't want to do anything; just continue.
        WinJS.Application.local.folder.createFileAsync(inkFile, Windows.Storage.CreationCollisionOption.replaceExisting).then
        (
            function(file)
            {
                file.openAsync(Windows.Storage.FileAccessMode.readWrite).then
                (
                    function(file)
                    {
                        var stream = file.getOutputStreamAt(0);
                        inkManager.saveAsync(stream).then
                        (
                            function()
                            {
                                stream.flushAsync().then(function() {suspendFlags.ink = true; checkDeferral();});
                            }
                        );
                    }
                );
            }
        );
    }
    else
    {
        suspendFlags.ink = true;
    }

    // Note how these Async calls have no error function (second arg to then()).  If there are any errors we don't want to do anything; just continue.
    displayDebug("handleSuspending about to make calls to writeText()");
    WinJS.Application.local.writeText("inkFile.text", inkFile).then(function() {suspendFlags.inkFile = true; checkDeferral();});
    WinJS.Application.local.writeText("inkMode.text", inkMode).then(function() {suspendFlags.inkMode = true; checkDeferral();});
    WinJS.Application.local.writeText("inkColor.text", inkContext.strokeStyle).then(function() {suspendFlags.inkColor = true; checkDeferral();});
    WinJS.Application.local.writeText("inkWidth.text", inkContext.lineWidth).then(function() {suspendFlags.inkWidth = true; checkDeferral();});
    WinJS.Application.local.writeText("highlightColor.text", hlContext.strokeStyle).then(function() {suspendFlags.highlightColor = true; checkDeferral();});
    WinJS.Application.local.writeText("highlightWidth.text", hlContext.lineWidth).then(function() {suspendFlags.highlightWidth = true; checkDeferral();});
    displayDebug("handleSuspending completed calls to writeText()");
}

function handleActivated(event)
{
    displayDebug("handleActivated");
    if (event.kind === Windows.ApplicationModel.Activation.ActivationKind.launch)
    {
        // Check the previousExecutionState; is this a re-activation after a suspension followed by a graceful termination?
        // If it is then we must have saved the state in the suspending handler. Retrieve the persisted state.
        // Note how these Async calls have no error function (second arg to then()).  If there are any errors we don't want to do anything; just continue.
        var reason = event.previousExecutionState;
        if ((reason === Windows.ApplicationModel.Activation.ApplicationExecutionState.terminated) ||
            (reason === Windows.ApplicationModel.Activation.ApplicationExecutionState.notRunning))
        {                
            // Obtain ink mode.
            displayDebug("handleActivated about to readText() on inkMode");
            WinJS.Application.local.readText("inkMode.text", "inking").then
            (
                function(str)
                {
                    switch(str)
                    {
                    case "highlighting":
                        highlightMode();
                        break;
                    case "selecting":
                        selectMode();
                        break;
                    case "erasing":
                        eraseMode();
                        break;
                    default:
                        inkMode();
                    }
                }
            );

            // Obtain ink color.
            displayDebug("handleActivated about to readText() on inkColor");
            WinJS.Application.local.readText("inkColor.text", "Black").then
            (
                function(str)
                {
                    inkContext.strokeStyle = str;
                    setDefaults();
                }
            );

            // Obtain ink width.
            displayDebug("handleActivated about to readText() on inkWidth");
            WinJS.Application.local.readText("inkWidth.text", "2").then
            (
                function(str)
                {
                    inkContext.lineWidth = str;
                    setDefaults();
                }
            );

            // Obtain highlight color.
            displayDebug("handleActivated about to readText() on highlightColor");
            WinJS.Application.local.readText("highlightColor.text", "Yellow").then
            (
                function(str)
                {
                    hlContext.strokeStyle = str;
                    setDefaults();
                }
            );

            // Obtain highlight width.
            displayDebug("handleActivated about to readText() on highlightWidth");
            WinJS.Application.local.readText("highlightWidth.text", "10").then
            (
                function(str)
                {
                    hlContext.lineWidth = str;
                    setDefaults();
                }
            );

             // Obtain highlight width.
            displayDebug("handleActivated about to readText() on inkFile");
            WinJS.Application.local.readText("inkFile.text", "").then
            (
                function(str)
                {
                    if (str !== "")
                    {
                        // Note how there is no error function (second arg to then()).
                        // If the file does not exist (or cannot be read), we do nothing.
                        displayDebug("handleActivated about to read file from " + str);
                        WinJS.Application.local.folder.getFileAsync(str).then(readInk);
                    }
                }
            );
        }
    }
}

// Utility to fetch elements by ID.
function id(elementId)
{
    return document.getElementById(elementId); 
}

function handleLayoutChange(event)
{
    hlCanvas.setAttribute("width", hlCanvas.offsetWidth);
    hlCanvas.setAttribute("height", hlCanvas.offsetHeight);
    inkCanvas.setAttribute("width", inkCanvas.offsetWidth);
    inkCanvas.setAttribute("height", inkCanvas.offsetHeight);
    selCanvas.setAttribute("width", selCanvas.offsetWidth);
    selCanvas.setAttribute("height", selCanvas.offsetHeight);

    renderAllStrokes();
}

function inkInitialize()
{
    try
    {
        WinJS.UI.processAll();

        displayStatus("Verba volant ...");

        appbar = WinJS.UI.getControl(id("bottomAppBar"));

        findFlyout = id("FindFlyout");
        inkColorsFlyout = id("InkColorFlyout");
        inkWidthsFlyout = id("InkWidthFlyout");
        hlColorsFlyout = id("HighlightColorFlyout");
        hlWidthsFlyout = id("HighlightWidthFlyout");
        moreFlyout = id("MoreFlyout");

        id("Reco").addEventListener("click", recognize, false);

        findText = id("FindString");             
        findFlyout.addEventListener("aftershow", function(evt) {findText.focus();}, false);
        id("FindButton").addEventListener("click", find, false);

        id("ModeSelect").addEventListener("click", selectMode, false);
        id("ModeErase").addEventListener("click", eraseMode, false);

        id("Black").addEventListener("click", inkColor, false);
        id("Blue").addEventListener("click", inkColor, false);
        id("Red").addEventListener("click", inkColor, false);
        id("Green").addEventListener("click", inkColor, false);

        id("Yellow").addEventListener("click", highlightColor, false);
        id("Aqua").addEventListener("click", highlightColor, false);
        id("Lime").addEventListener("click", highlightColor, false);

        for (var i = 2; i < 11; i += 2)
        {
            id("IW" + i).addEventListener("click", setInkWidth, false);
        }

        for (var i = 10; i < 31; i += 10)
        {
            id("HW" + i).addEventListener("click", setHighlightWidth, false);
        }

        hlCanvas = id("HighlightCanvas");
        hlCanvas.setAttribute("width", hlCanvas.offsetWidth);
        hlCanvas.setAttribute("height", hlCanvas.offsetHeight);
        hlContext = hlCanvas.getContext("2d");
        hlContext.lineWidth = 10;
        hlContext.strokeStyle = "Yellow";
        hlContext.lineCap = "round";
        hlContext.lineJoin = "round";

        inkCanvas = id("InkCanvas");
        inkCanvas.setAttribute("width", inkCanvas.offsetWidth);
        inkCanvas.setAttribute("height", inkCanvas.offsetHeight);
        inkContext = inkCanvas.getContext("2d");
        inkContext.lineWidth = 2;
        inkContext.strokeStyle = "Black";
        inkContext.lineCap = "round";
        inkContext.lineJoin = "round";

        selCanvas = id("SelectCanvas");
        selCanvas.setAttribute("width", selCanvas.offsetWidth);
        selCanvas.setAttribute("height", selCanvas.offsetHeight);
        selContext = selCanvas.getContext("2d");
        selContext.lineWidth = 1;
        selContext.strokeStyle = "Gold";
        selContext.lineCap = "round";
        selContext.lineJoin = "round";

        // Note that we must set the event listeners on the top-most canvas.

        selCanvas.addEventListener("MSPointerDown", handlePointerDown, false);
        selCanvas.addEventListener("MSPointerUp", handlePointerUp, false);
        selCanvas.addEventListener("MSPointerMove", handlePointerMove, false);
        selCanvas.addEventListener("MSPointerOut", handlePointerOut, false);

        var image = new Image();
        image.onload = function() {selContext.strokeStyle = selPattern = selContext.createPattern(image, "repeat");};
        image.src = "images/select.png";

        recoFlyout = id("RecoFlyout");
        clipButtons = new Array();
        for (var i = 0; i < 5; i++)
        {
            var ID = "Reco" + i;
            clipButtons[i] = id(ID);
            clipButtons[i].addEventListener("click", recoClipboard, false);
        }

        id("CopySelected").addEventListener("click", copySelected, false);
        id("Paste").addEventListener("click", paste, false);
        id("Save").addEventListener("click", save, false);
        id("Load").addEventListener("click", load, false);
        id("Clear").addEventListener("click", clear, false);

        document.body.addEventListener("keypress", keypress, false);

        if (!setRecognizerByName("Microsoft English (US) Handwriting Recognizer"))
        {
            displayStatus("Failed to find English (US) recognizer");
        }
        else
        {
            displayStatus("Verba volant, scripta manent");
        }
    
        inkMode();
        renderPaper();

        var mqlFull = msMatchMedia("all and (-ms-view-state: full-screen)");
        mqlFull.addListener(handleLayoutChange); 
        var mqlSnapped = msMatchMedia("all and (-ms-view-state: snapped)");
        mqlSnapped.addListener(handleLayoutChange);
        var mqlFill = msMatchMedia("all and (-ms-view-state: fill)");
        mqlFill.addListener(handleLayoutChange);
        var mqlPortrait = msMatchMedia("all and (-ms-view-state: device-portrait)");
        mqlPortrait.addListener(handleLayoutChange);

        Windows.UI.WebUI.WebUIApplication.addEventListener("activated",  handleActivated,  false);
        Windows.UI.WebUI.WebUIApplication.addEventListener("suspending", handleSuspending, false);
    }
    catch (e)
    {
        displayError("inkInitialize " + e.toString());
    }
}

document.addEventListener("DOMContentLoaded", inkInitialize, false);

